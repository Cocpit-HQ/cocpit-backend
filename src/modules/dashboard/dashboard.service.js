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

  // Atomic distributed cache check (24h TTL)
  const isNewView = await redis.set(
    cacheKey,
    "1",
    "NX",
    "EX",
    86400
  );

  if (!isNewView) return;

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
 * Get dashboard statistics for an actor (user or organization)
 * @param {string} actorId
 * @param {'USER'|'ORGANIZATION'} actorType
 * @returns {Promise<Object>}
 */
const getStats = async (actorId, actorType) => {
  return {
    overview: {
      totalViews: await getProfileViewCount(actorId, actorType.toLowerCase()),
      totalConnections: 0,
      activeJobs: 0,
    },
    recentActivity: [],
  };
};

module.exports = {
  getStats,
  addProfileView,
  getProfileViewCount,
};
