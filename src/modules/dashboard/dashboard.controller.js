const dashboardService = require("./dashboard.service");
const { sendSuccess } = require("../../core/response/success");
const pool = require("../../core/db/pool");
const { getUserType } = require("../../utils/personaHelper");

const getDashboardStats = async (req, res) => {
  try {
    const actorId = req.actor?.id || req.user.sub || req.user.id;
    const actorType = req.actor?.type || "USER";
    const stats = await dashboardService.getStats(actorId, actorType);

    // 🎯 Intent Layer Integration: Add Persona/Intent only for Users
    if (actorType === "USER") {
      const intent = await dashboardService.getIntentScores(actorId);
      const hasCreatedPost = await dashboardService.checkUserCreatedPost(actorId);
      const userType = getUserType(intent, hasCreatedPost);
      
      stats.intent = intent;
      stats.userType = userType;
    }

    return sendSuccess(res, stats, 200, "Dashboard statistics retrieved successfully");
  } catch (err) {
    console.error("Get dashboard stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const recordProfileView = async (req, res) => {
  const { profileOwnerId, profileType, source, sourcePostId } = req.body;
  const viewerId = req.user.sub || req.user.id;
  const actorType = req.headers["x-actor-type"];
  const actorId = req.headers["x-actor-id"];
  let viewerCompanyOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : (actorType === "ORGANIZATION" && actorId ? actorId : null);

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let validSourcePostId = sourcePostId;
  if (validSourcePostId && !UUID_REGEX.test(validSourcePostId)) {
    validSourcePostId = null; // silently ignore invalid UUID
  }

  if (!viewerCompanyOrgId) {
    try {
      const orgRes = await pool.query("SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1", [viewerId]);
      if (orgRes.rowCount > 0) {
        viewerCompanyOrgId = orgRes.rows[0].org_id;
      }
    } catch (e) {
      console.error("Failed to fetch org for viewer:", e);
    }
  }

  try {
    await dashboardService.addProfileView(viewerId, profileOwnerId, profileType, {
        source,
        sourcePostId: validSourcePostId,
        viewerCompanyOrgId
    });
    const totalViews = await dashboardService.getProfileViewCount(profileOwnerId, profileType);
    return sendSuccess(res, { totalViews }, 200, "Profile view recorded successfully");
  } catch (err) {
    if (err.message === "Profile not found") {
      return res.status(404).json({ message: "Profile not found" });
    }
    console.error("Record profile view error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getProfileViews = async (req, res) => {
  const { profileOwnerId, profileType } = req.params;

  try {
    const totalViews = await dashboardService.getProfileViewCount(profileOwnerId, profileType);
    return sendSuccess(res, { profileOwnerId, profileType, totalViews }, 200, "Profile view count retrieved successfully");
  } catch (err) {
    if (err.message === "Profile not found") {
      return res.status(404).json({ message: "Profile not found" });
    }
    console.error("Get profile views error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getSearchAppearanceCount = async (req, res) => {
  const { profileId, profileType } = req.params;

  try {
    const count = await dashboardService.getSearchAppearanceCount(profileId, profileType);
    return sendSuccess(res, { profileId, profileType, searchAppearances: count }, 200, "Search appearance count retrieved successfully");
  } catch (err) {
    if (err.message === "Profile not found") {
      return res.status(404).json({ message: "Profile not found" });
    }
    console.error("Get search appearance count error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const recordImpression = async (req, res) => {
  const { id: postId } = req.params;
  
  // Use actor context if available
  const userId = req.user?.sub || req.user?.id || null;
  const companyId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

  try {


    // Build a unique key for Redis debouncing for authenticated actors
    if (userId) {
      const actorType = companyId ? 'organization' : 'user';
      const actorIdentifier = companyId || userId;
      const redisKey = `impression:${postId}:${actorType}:${actorIdentifier}`;

      // Check if impression was recently recorded (5 minutes = 300 seconds)
      const redis = require("../../core/cache/redis");
      const isRedisReady = redis.status === "ready";
      
      let exists = false;
      if (isRedisReady) {
        exists = await redis.get(redisKey);
      }
      
      if (exists) {

        return res.status(204).send(); // No Content - already recorded
      }

      // Set Redis key with 5-minute expiry only if Redis is ready
      if (isRedisReady) {
        await redis.set(redisKey, "1", "EX", 300);
      }

      // Record in Database
      await pool.query(
        `INSERT INTO post_impressions (post_id, viewer_id, viewer_org_id, view_date)
                 VALUES ($1, $2, $3, CURRENT_DATE)`,
        [postId, userId, companyId || null]
      );

    } else {
      // Anonymous impression
      await pool.query(
        `INSERT INTO post_impressions (post_id, view_date) VALUES ($1, CURRENT_DATE)`,
        [postId]
      );

    }

    res.status(204).send();
  } catch (err) {
    console.error(`[ERROR] Record impression error for post ${postId}:`, err.message);
    // Fail silently for user experience, but log for debugging
    res.status(204).send();
  }
};

module.exports = {
  getDashboardStats,
  recordProfileView,
  getProfileViews,
  getSearchAppearanceCount,
  recordImpression,
};
