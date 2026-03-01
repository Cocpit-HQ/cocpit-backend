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

module.exports = {
    checkBlockStatus
};
