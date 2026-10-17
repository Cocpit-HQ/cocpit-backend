const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");

const CACHE_TTL = 3600; // 1 hour

class BlockModel {
    /**
     * Block a user
     * @param {string} blockerId 
     * @param {string} blockedId 
     * @param {boolean} isOrgBlock
     */
    static async blockUser(blockerId, blockedId, isOrgBlock = false) {
        if (blockerId === blockedId) {
            throw new Error("Cannot block yourself");
        }

        const result = await pool.query(
            `INSERT INTO blocks (blocker_id, blocked_id, is_org_block) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (blocker_id, blocked_id, is_org_block) DO NOTHING 
             RETURNING *`,
            [blockerId, blockedId, isOrgBlock]
        );

        // INVALIDATE CACHE (Both users need update)
        await this.invalidateCache(blockerId);
        await this.invalidateCache(blockedId);

        return result.rows[0];
    }

    /**
     * Unblock a user
     * @param {string} blockerId 
     * @param {string} blockedId 
     * @param {boolean} isOrgBlock
     */
    static async unblockUser(blockerId, blockedId, isOrgBlock = false) {
        await pool.query(
            `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 AND is_org_block = $3`,
            [blockerId, blockedId, isOrgBlock]
        );

        // INVALIDATE CACHE
        await this.invalidateCache(blockerId);
        await this.invalidateCache(blockedId);
    }

    /**
     * Check if a personal block exists between two users
     * @param {string} userA 
     * @param {string} userB 
     */
    static async isBlocked(userA, userB) {
        const result = await pool.query(
            `SELECT 1 FROM blocks 
             WHERE is_org_block = false
               AND ((blocker_id = $1 AND blocked_id = $2) 
                 OR (blocker_id = $2 AND blocked_id = $1))`,
            [userA, userB]
        );
        return result.rowCount > 0;
    }

    static async getBlockedIdsForUser(userId) {
        const result = await pool.query(
            `SELECT blocked_id FROM blocks WHERE blocker_id = $1 AND is_org_block = false`,
            [userId]
        );
        return result.rows.map(row => row.blocked_id);
    }

    /**
     * Check if an org block exists between orgId and targetUserId
     * @param {string} orgId 
     * @param {string} targetUserId 
     */
    static async isOrgBlocked(orgId, targetUserId) {
        if (!orgId || !targetUserId) return false;
        const result = await pool.query(
            `SELECT 1 FROM blocks 
             WHERE (blocker_id = $1 AND blocked_id = $2 AND is_org_block = true)
                OR (blocker_id = $2 AND blocked_id = $1)`,
            [orgId, targetUserId]
        );
        return result.rowCount > 0;
    }

    /**
     * Check if ANY block exists between two entities (bi-directional: User<->User, User<->Org, Org<->User, Org<->Org)
     * @param {string} entityA 
     * @param {string} entityB 
     */
    static async isAnyBlocked(entityA, entityB) {
        if (!entityA || !entityB) return false;
        if (entityA === entityB) return false;
        const result = await pool.query(
            `SELECT 1 FROM blocks 
             WHERE (blocker_id = $1 AND blocked_id = $2)
                OR (blocker_id = $2 AND blocked_id = $1)`,
            [entityA, entityB]
        );
        return result.rowCount > 0;
    }

    /**
     * Get detailed list of users and organizations blocked BY userId (personal)
     * @param {string} userId 
     */
    static async getBlockedUsersDetails(userId) {
        const result = await pool.query(
            `SELECT 
                COALESCE(u.user_id, o.org_id) AS user_id,
                COALESCE(u.full_name, o.name) AS full_name,
                COALESCE(u.avatar_url, o.logo_url) AS avatar_url,
                COALESCE(u.headline, o.headline, '') AS headline,
                COALESCE(u.account_name, o.slug) AS account_name,
                b.created_at,
                CASE WHEN o.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END AS entity_type
             FROM blocks b
             LEFT JOIN active_users u ON b.blocked_id = u.user_id AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL)
             LEFT JOIN active_organizations o ON b.blocked_id = o.org_id
             WHERE b.blocker_id = $1 AND b.is_org_block = false
               AND (u.user_id IS NOT NULL OR o.org_id IS NOT NULL)
             ORDER BY b.created_at DESC`,
            [userId]
        );
        return result.rows;
    }

    /**
     * Get detailed list of users and organizations blocked BY orgId
     * @param {string} orgId 
     */
    static async getOrgBlockedUsersDetails(orgId) {
        const result = await pool.query(
            `SELECT 
                COALESCE(u.user_id, o.org_id) AS user_id,
                COALESCE(u.full_name, o.name) AS full_name,
                COALESCE(u.avatar_url, o.logo_url) AS avatar_url,
                COALESCE(u.headline, o.headline, '') AS headline,
                COALESCE(u.account_name, o.slug) AS account_name,
                b.created_at,
                CASE WHEN o.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END AS entity_type
             FROM blocks b
             LEFT JOIN active_users u ON b.blocked_id = u.user_id AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL)
             LEFT JOIN active_organizations o ON b.blocked_id = o.org_id
             WHERE b.blocker_id = $1 AND b.is_org_block = true
               AND (u.user_id IS NOT NULL OR o.org_id IS NOT NULL)
             ORDER BY b.created_at DESC`,
            [orgId]
        );
        return result.rows;
    }

    /**
     * Get list of users who blocked userId (personal)
     * @param {string} userId 
     */
    static async getBlockerIdsForUser(userId) {
        const result = await pool.query(
            `SELECT blocker_id FROM blocks WHERE blocked_id = $1 AND is_org_block = false`,
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
                // Existing: clear block cache
                await redisClient.del(this.getCacheKey(userId));
                await redisClient.del(this.getCacheKey(userId) + ":empty");

                // NEW: clear feed candidate pool (TTL 120s key)
                await redisClient.del(`feed:candidates:${userId}`);

                // NEW: clear all paginated feed slice keys for this user
                // Pattern: feed:slice:{userId}:{cursor}  (TTL 300s each)
                // SCAN is non-blocking and safe on single-instance Redis
                let cursor = 0;
                do {
                    const reply = await redisClient.scan(cursor, {
                        MATCH: `feed:slice:${userId}:*`,
                        COUNT: 100,
                    });
                    cursor = reply.cursor;
                    if (reply.keys && reply.keys.length > 0) {
                        await redisClient.del(reply.keys);
                    }
                } while (cursor !== 0);
            }
        } catch (err) {
            console.warn("Redis invalidation error:", err.message);
        }
    }

    static async getBlockedAndBlockingIds(userId) {
        const result = await pool.query(
            `SELECT blocked_id AS related_id FROM blocks WHERE blocker_id = $1
             UNION
             SELECT blocker_id AS related_id FROM blocks WHERE blocked_id = $1`,
            [userId]
        );
        return new Set(result.rows.map(r => r.related_id));
    }

    /**
     * Populate cache for a user.
     * Stores ALL users that share a personal block relationship (blocked by me OR blocked me).
     * This allows checkBlockStatus(me, other) to work by checking if 'other' is in my set.
     */
    static async cacheBlocks(userId) {
        try {
            if (!redisClient.isOpen) return;

            // Fetch ALL related personal blocks
            const result = await pool.query(
                `SELECT blocked_id AS related_id FROM blocks WHERE blocker_id = $1 AND is_org_block = false
                 UNION
                 SELECT blocker_id AS related_id FROM blocks WHERE blocked_id = $1 AND is_org_block = false`,
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
