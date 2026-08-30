const pool = require("../../core/db/pool");

const redis = require("../../core/cache/redis");

// Module-scoped in-memory deduplication map — fallback for Redis downtime.
// Redis is the primary distributed layer; this only catches duplicate requests
// within the same process before Redis responds.
// Capped at 10,000 entries to prevent unbounded memory growth.
const VIEW_SAFETY_MAP_MAX_SIZE = 10_000;
const viewSafetyMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of viewSafetyMap.entries()) {
    if (now - timestamp > 3_600_000) viewSafetyMap.delete(key);
  }
}, 3_600_000);

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
const addProfileView = async (viewerId, profileOwnerIdentifier, profileType, options = {}) => {
  if (!viewerId || !profileOwnerIdentifier || !["user", "organization"].includes(profileType)) {
    throw new Error("Invalid parameters for profile view.");
  }

  const profileOwnerId = await resolveProfileId(profileOwnerIdentifier, profileType);

  if (viewerId === profileOwnerId) return;

  let { source = null, sourcePostId = null, viewerCompanyOrgId = null, actor = null } = options;

  // Resolve org context: explicit orgId takes priority, then actor type
  const isOrgView = viewerCompanyOrgId || (actor && actor.type === 'ORGANIZATION');
  const orgId = isOrgView ? (viewerCompanyOrgId || actor?.orgId) : null;

  const finalSource = source || (sourcePostId ? 'post' : null);
  const hasAttribution = Boolean(sourcePostId || finalSource || orgId);

  const nowDate = new Date();
  const today = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;

  // Cache key scoped to the viewing entity (org or personal user)
  const cacheKey = isOrgView
    ? `profile_view:org:${orgId}:${profileOwnerId}:${profileType}:${today}`
    : `profile_view:${viewerId}:${profileOwnerId}:${profileType}:${today}`;

  const attributionCacheKey = hasAttribution
    ? `${cacheKey}:src:${finalSource || ''}:post:${sourcePostId || ''}`
    : cacheKey;

  // 1. In-memory safety fallback (protects against Redis downtime + extra layer)
  // Evict oldest entry if map is at capacity (LRU-lite)
  if (viewSafetyMap.size >= VIEW_SAFETY_MAP_MAX_SIZE) {
    const oldestKey = viewSafetyMap.keys().next().value;
    viewSafetyMap.delete(oldestKey);
  }

  // If already tracked with this exact attribution, skip
  if (viewSafetyMap.has(attributionCacheKey)) return;
  viewSafetyMap.set(attributionCacheKey, Date.now());
  if (!hasAttribution) {
    viewSafetyMap.set(cacheKey, Date.now());
  }

  // 2. Redis distributed cache check (24h TTL)
  if (redis.status === "ready") {
    try {
      const isNewView = await redis.set(
        attributionCacheKey,
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
    if (isOrgView && orgId) {
      if (profileType !== 'user') {
        return; // The organization_profile_views table only supports user profiles as targets.
      }

      // Insert into organization_profile_views
      await pool.query(`
          INSERT INTO organization_profile_views (organization_id, profile_owner_id, profile_type, viewed_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (organization_id, profile_owner_id, profile_type, ((viewed_at AT TIME ZONE 'UTC')::date)) DO NOTHING
      `, [orgId, profileOwnerId, profileType]);
    }

    // 2. Insert into profile_views (for personal views, and org views that need source tracking like Opportunity Views)
    // Pass orgId to viewer_company_org_id so the cron job knows to exclude it from Overview aggregations
    await pool.query(
      `
      INSERT INTO profile_views (viewer_id, profile_owner_id, profile_type, view_date, source, source_post_id, viewer_company_org_id, viewer_industry)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, (SELECT job_title FROM users WHERE user_id = $1))
      ON CONFLICT (viewer_id, profile_owner_id, profile_type, view_date) 
      DO UPDATE SET 
        source = COALESCE(EXCLUDED.source, profile_views.source),
        source_post_id = COALESCE(EXCLUDED.source_post_id, profile_views.source_post_id),
        viewer_company_org_id = CASE 
          WHEN EXCLUDED.viewer_company_org_id IS NULL OR profile_views.viewer_company_org_id IS NULL 
          THEN NULL   
          ELSE EXCLUDED.viewer_company_org_id 
        END
      RETURNING view_id
      `,
      [viewerId, profileOwnerId, profileType, finalSource, sourcePostId, isOrgView ? orgId : null]
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

/**
 * Fetches user intent scores
 * @param {string} userId
 */
const getIntentScores = async (userId) => {
    const { rows } = await pool.query(
        "SELECT job_seeker_score, creator_score, event_score FROM user_intent_scores WHERE user_id = $1",
        [userId]
    );
    return rows[0] || { job_seeker_score: 0, creator_score: 0, event_score: 0 };
};

/**
 * Checks if a user has created any posts
 * @param {string} userId
 */
const checkUserCreatedPost = async (userId) => {
    const { rows } = await pool.query(
        "SELECT 1 FROM posts WHERE author_id = $1 AND author_org_id IS NULL LIMIT 1",
        [userId]
    );
    return rows.length > 0;
};

module.exports = {
  getStats,
  addProfileView,
  getProfileViewCount,
  addSearchAppearance,
  getSearchAppearanceCount,
  getConnectionCount,
  getPostImpressionsCount,
  getIntentScores,
  checkUserCreatedPost,
};
