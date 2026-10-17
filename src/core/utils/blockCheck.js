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
 * Handles bi-directional blocking between User<->User, User<->Org, Org<->User, Org<->Org.
 * @param {object} req - Express request object containing req.actor & req.user
 * @param {string} targetId - The ID of the target user or organization
 * @returns {Promise<boolean>} True if blocked, false otherwise
 */
const checkActorBlockStatus = async (req, targetId) => {
    if (!req || !targetId) return false;
    const activeActorId = req.actor?.type === "ORGANIZATION" && req.actor?.orgId
        ? req.actor.orgId
        : req.user?.sub;
    if (!activeActorId || activeActorId === targetId) return false;
    return await BlockModel.isAnyBlocked(activeActorId, targetId);
};

/**
 * Check if ANY block exists between two entity IDs (bi-directional).
 * @param {string} entityA
 * @param {string} entityB
 * @returns {Promise<boolean>}
 */
const checkAnyBlockStatus = async (entityA, entityB) => {
    if (!entityA || !entityB) return false;
    if (entityA === entityB) return false;
    return await BlockModel.isAnyBlocked(entityA, entityB);
};

module.exports = {
    checkBlockStatus,
    checkActorBlockStatus,
    checkAnyBlockStatus,
};
