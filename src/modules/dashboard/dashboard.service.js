const pool = require("../../core/db/pool");

const redis = require("../../core/cache/redis");

/**
 * Resolve a profile identifier (username or slug) to a UUID
 */
const resolveProfileId = async (identifier, type) => {
  const uuidRegex = /^[0-9a-f-]{36}$/i;
  if (uuidRegex.test(identifier)) return identifier;

  const query = type === "user"
    ? "SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)"
    : "SELECT org_id FROM organizations WHERE LOWER(slug) = LOWER($1)";

  const { rows } = await pool.query(query, [identifier]);

  if (!rows.length) {
    throw new Error("Profile not found");
  }

  return type === "user" ? rows[0].user_id : rows[0].org_id;
};

/**
 * Record a profile view
 * @param {string} viewerId - ID of the viewer (user)
 * @param {string} profileOwnerIdentifier - ID or username/slug of the profile being viewed
 * @param {'user'|'organization'} profileType - Type of the profile
 */
const addProfileView = async (viewerId, profileOwnerIdentifier, profileType) => {
  if (!viewerId || !profileOwnerIdentifier || !["user", "organization"].includes(profileType)) {
    throw new Error("Invalid parameters for profile view.");
  }

  const profileOwnerId = await resolveProfileId(profileOwnerIdentifier, profileType);

  if (viewerId === profileOwnerId) return;

  const nowDate = new Date();
  const today = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
  const cacheKey = `profile_view:${viewerId}:${profileOwnerId}:${profileType}:${today}`;

  // 1. In-memory safety fallback (protects against Redis downtime + extra layer)
  if (!global.viewSafetyMap) {
    global.viewSafetyMap = new Map();
    // Cleanup old keys every hour
    setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of global.viewSafetyMap.entries()) {
        if (now - timestamp > 3600000) global.viewSafetyMap.delete(key);
      }
    }, 3600000);
  }

  if (global.viewSafetyMap.has(cacheKey)) return;
  global.viewSafetyMap.set(cacheKey, Date.now());

  // 2. Redis distributed cache check (24h TTL)
  if (redis.status === "ready") {
    try {
      const isNewView = await redis.set(
        cacheKey,
        "1",
        "NX",
        "EX",
        86400
      );
      if (!isNewView) return;
    } catch (err) {
      // Logic continues to DB if Redis fails, but in-memory map already caught near-duplicates
      console.warn("[DashboardService] Redis cache check skipped during view tracking");
    }
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO profile_views (viewer_id, profile_owner_id, profile_type, view_date)
      VALUES ($1, $2, $3, CURRENT_DATE)
      ON CONFLICT ON CONSTRAINT unique_24hr_view
      DO NOTHING
      RETURNING viewer_id
      `,
      [viewerId, profileOwnerId, profileType]
    );

  } catch (err) {
    console.error("Error adding profile view:", err);
    throw err;
  }
};

/**
 * Get total profile views for a given profile
 * @param {string} profileOwnerId
 * @param {'user'|'organization'} profileType
 */
const getProfileViewCount = async (profileOwnerIdentifier, profileType) => {
  const profileOwnerId = await resolveProfileId(profileOwnerIdentifier, profileType);

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total_views
    FROM profile_views
    WHERE profile_owner_id = $1
      AND profile_type = $2
    `,
    [profileOwnerId, profileType]
  );

  return rows[0].total_views;
};

/**
 * Add search appearance
 * One appearance per user per profile per day
 */
const addSearchAppearance = async (viewerId, profileOwnerId, profileType) => {
  if (!profileOwnerId || !profileType) return;

  try {
    await pool.query(
      `
      INSERT INTO search_appearances
      (viewer_id, profile_owner_id, profile_type, appearance_date)
      VALUES ($1,$2,$3,CURRENT_DATE)
      ON CONFLICT ON CONSTRAINT unique_daily_search
      DO NOTHING
      `,
      [viewerId, profileOwnerId, profileType]
    );
  } catch (err) {
    if (err.code !== "23505") return; // Silently handle duplicate key
    console.error("Error adding search appearance:", err);
  }
};

/**
 * Get total search appearances
 */
const getSearchAppearanceCount = async (profileOwnerId, profileType) => {
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM search_appearances
    WHERE profile_owner_id = $1
    AND profile_type = $2
    `,
    [profileOwnerId, profileType]
  );

  return rows[0].total;
};

/**
 * Get connection request count for an actor
 * For users: counts pending connection requests received
 * For organizations: counts pending organization connection requests
 * @param {string} actorId
 * @param {'user'|'organization'} actorType
 * @returns {Promise<number>}
 */
const getConnectionCount = async (actorId, actorType) => {
  if (actorType === "organization") {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM organization_connection_requests WHERE org_id = $1 AND status = 'pending'`,
      [actorId]
    );
    return rows[0].count;
  }

  // User actor: pending connection requests received
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM connection_requests WHERE receiver_id = $1 AND status = 'pending'`,
    [actorId]
  );
  return rows[0].count;
};

/**
 * Get total post impressions for an actor
 * @param {string} actorId
 * @param {'user'|'organization'} actorType
 * @returns {Promise<number>}
 */
const getPostImpressionsCount = async (actorId, actorType) => {
  const query = actorType === "organization"
    ? `SELECT COUNT(*)::int AS count FROM post_impressions pi 
       JOIN posts p ON pi.post_id = p.post_id 
       WHERE p.author_org_id = $1`
    : `SELECT COUNT(*)::int AS count FROM post_impressions pi
       JOIN posts p ON pi.post_id = p.post_id
       WHERE p.author_id = $1 AND p.author_org_id IS NULL`;

  const { rows } = await pool.query(query, [actorId]);
  return rows[0].count;
};

/**
 * Get dashboard statistics for an actor (user or organization)
 * Uses Promise.all for parallel execution
 * @param {string} actorId
 * @param {'USER'|'ORGANIZATION'} actorType
 * @returns {Promise<Object>}
 */
const getStats = async (actorId, actorType) => {
  const type = actorType.toLowerCase();

  const [totalViews, searchAppearances, totalConnections, totalImpressions] = await Promise.all([
    getProfileViewCount(actorId, type),
    getSearchAppearanceCount(actorId, type),
    getConnectionCount(actorId, type),
    getPostImpressionsCount(actorId, type),
  ]);

  return {
    overview: {
      totalViews,
      searchAppearances,
      totalConnections,
      totalImpressions,
    },
  };
};

module.exports = {
  getStats,
  addProfileView,
  getProfileViewCount,
  addSearchAppearance,
  getSearchAppearanceCount,
  getConnectionCount,
  getPostImpressionsCount,
};
