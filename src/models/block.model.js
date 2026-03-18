const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");

const CACHE_TTL = 3600; // 1 hour

class BlockModel {
    /**
     * Block a user
     * @param {string} blockerId 
     * @param {string} blockedId 
     */
    static async blockUser(blockerId, blockedId) {
        if (blockerId === blockedId) {
            throw new Error("Cannot block yourself");
        }

        const result = await pool.query(
            `INSERT INTO blocks (blocker_id, blocked_id) 
             VALUES ($1, $2) 
             ON CONFLICT (blocker_id, blocked_id) DO NOTHING 
             RETURNING *`,
            [blockerId, blockedId]
        );

        // INVALIDATE CACHE (Both users need update)
        // user:blocks:{blockerId} now includes blockedId
        // user:blocks:{blockedId} now includes blockerId (reciprocal visibility check)
        await this.invalidateCache(blockerId);
        await this.invalidateCache(blockedId);

        return result.rows[0];
    }

    /**
     * Unblock a user
     * @param {string} blockerId 
     * @param {string} blockedId 
     */
    static async unblockUser(blockerId, blockedId) {
        await pool.query(
            `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
            [blockerId, blockedId]
        );

        // INVALIDATE CACHE
        await this.invalidateCache(blockerId);
        await this.invalidateCache(blockedId);
    }

    /**
     * Check if a block exists between two users
     * @param {string} userA 
     * @param {string} userB 
     */
    static async isBlocked(userA, userB) {
        const result = await pool.query(
            `SELECT 1 FROM blocks 
             WHERE (blocker_id = $1 AND blocked_id = $2) 
                OR (blocker_id = $2 AND blocked_id = $1)`,
            [userA, userB]
        );
        return result.rowCount > 0;
    }

    static async getBlockedIdsForUser(userId) {
        const result = await pool.query(
            `SELECT blocked_id FROM blocks WHERE blocker_id = $1`,
            [userId]
        );
        return result.rows.map(row => row.blocked_id);
    }

    /**
     * Get detailed list of users blocked BY userId
     * @param {string} userId 
     */
    static async getBlockedUsersDetails(userId) {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name 
             FROM blocks b
             JOIN users u ON b.blocked_id = u.user_id
             WHERE b.blocker_id = $1`,
            [userId]
        );
        return result.rows;
    }

    /**
     * Get list of users who blocked userId
     * @param {string} userId 
     */
    static async getBlockerIdsForUser(userId) {
        const result = await pool.query(
            `SELECT blocker_id FROM blocks WHERE blocked_id = $1`,
            [userId]
        );
        return result.rows.map(row => row.blocker_id);
    }

    // --- CACHE HELPERS ---

    static getCacheKey(userId) {
        return `user:blocks:${userId}`;
    }

    static async invalidateCache(userId) {
        try {
            if (redisClient.isOpen) {
                await redisClient.del(this.getCacheKey(userId));
                // Clear emptiness marker too
                await redisClient.del(this.getCacheKey(userId) + ":empty");
            }
        } catch (err) {
            console.warn("Redis invalidation error:", err.message);
        }
    }

    /**
     * Populate cache for a user.
     * Stores ALL users that share a block relationship (blocked by me OR blocked me).
     * This allows checkBlockStatus(me, other) to work by checking if 'other' is in my set.
     */
    static async cacheBlocks(userId) {
        try {
            if (!redisClient.isOpen) return;

            // Fetch ALL related blocks
            const result = await pool.query(
                `SELECT blocked_id AS related_id FROM blocks WHERE blocker_id = $1
                 UNION
                 SELECT blocker_id AS related_id FROM blocks WHERE blocked_id = $1`,
                [userId]
            );

            const ids = result.rows.map(r => r.related_id);
            const key = this.getCacheKey(userId);

            if (ids.length > 0) {
                await redisClient.sAdd(key, ids);
                await redisClient.expire(key, CACHE_TTL);
            } else {
                // Use positional arguments for better compatibility
                await redisClient.set(key + ":empty", "1", "EX", CACHE_TTL);
            }
        } catch (err) {
            console.warn("Redis caching error:", err.message);
        }
    }

    // Updated helper to fetch from cache or DB
    static async getBlockedSet(userId) {
        if (!redisClient.isOpen) return null; // Fallback

        const key = this.getCacheKey(userId);

        // Check if empty marker exists
        const isEmpty = await redisClient.get(key + ":empty");
        if (isEmpty) return new Set();

        // Check actual set
        const members = await redisClient.sMembers(key);
        if (members && members.length > 0) {
            return new Set(members);
        }

        // If neither, cache is cold -> return null to trigger DB
        return null;
    }
}

module.exports = BlockModel;
