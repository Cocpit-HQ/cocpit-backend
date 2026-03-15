const dashboardService = require("./dashboard.service");
const { sendSuccess } = require("../../core/response/success");

const getDashboardStats = async (req, res) => {
  try {
    const actorId = req.actor?.id || req.user.sub || req.user.id;
    const actorType = req.actor?.type || "USER";
    const stats = await dashboardService.getStats(actorId, actorType);
    return sendSuccess(res, stats, 200, "Dashboard statistics retrieved successfully");
  } catch (err) {
    console.error("Get dashboard stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const recordProfileView = async (req, res) => {
  const { profileOwnerId, profileType } = req.body;
  const viewerId = req.user.sub || req.user.id;

  try {
    await dashboardService.addProfileView(viewerId, profileOwnerId, profileType);
    const totalViews = await dashboardService.getProfileViewCount(profileOwnerId, profileType);
    return sendSuccess(res, { totalViews }, 200, "Profile view recorded successfully");
  } catch (err) {
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
    console.error("Get profile views error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  getDashboardStats,
  recordProfileView,
  getProfileViews,
};
