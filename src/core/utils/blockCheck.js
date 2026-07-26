const BlockModel = require("../../models/block.model");

/**
 * Check if there is a block between two users (bi-directional).
 * @param {string} userId - The ID of the current user (e.g., requester)
 * @param {string} targetId - The ID of the target user
 * @returns {Promise<boolean>} True if blocked, false otherwise
 */
const checkBlockStatus = async (userId, targetId) => {
    if (!userId || !targetId) return false;
    if (userId === targetId) return false;

    // 1. Try Cache
    try {
        const cachedSet = await BlockModel.getBlockedSet(userId);
        if (cachedSet) {
            return cachedSet.has(targetId);
        }
    } catch (err) {
        console.warn("Block check cache failed, falling back to DB", err);
    }

    // 2. Fallback to DB & Populate Cache
    const isBlocked = await BlockModel.isBlocked(userId, targetId);

    // Lazy Load: Since we missed cache, populate it now for next time
    BlockModel.cacheBlocks(userId).catch(err => console.error("Cache population error", err));

    return isBlocked;
};

/**
 * Check block status respecting request actor context (User or Organization).
 * @param {object} req - Express request object containing req.actor & req.user
 * @param {string} targetId - The ID of the target user
 * @returns {Promise<boolean>} True if blocked, false otherwise
 */
const checkActorBlockStatus = async (req, targetId) => {
    if (!req || !targetId) return false;
    const isOrgActor = req.actor?.type === "ORGANIZATION";
    if (isOrgActor && req.actor?.orgId) {
        return await BlockModel.isOrgBlocked(req.actor.orgId, targetId);
    }
    const currentUserId = req.user?.sub;
    return await checkBlockStatus(currentUserId, targetId);
};

module.exports = {
    checkBlockStatus,
    checkActorBlockStatus,
};
