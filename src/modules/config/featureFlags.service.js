const redis = require('../../core/cache/redis');
const pool = require('../../core/db/pool');

let inMemoryFlags = {};

const getFlags = () => {
    return inMemoryFlags;
};

const updateFlagInMemory = (key, value) => {
    inMemoryFlags[key] = value;
    console.log(`🔄 Feature flag updated in memory: ${key} = ${value}`);
};

const initFlagsFromRedis = async () => {
    try {
        const { rows } = await pool.query('SELECT flag_key, is_enabled FROM feature_flags');
        if (rows.length > 0) {
            let redisFailed = false;
            for (const row of rows) {
                const { flag_key, is_enabled } = row;
                // Hydrate memory FIRST
                inMemoryFlags[flag_key] = is_enabled;
                // Hydrate Redis from DB, gracefully handle failure
                try {
                    await redis.set(`feature_flag:${flag_key}`, is_enabled ? 'true' : 'false');
                } catch (redisErr) {
                    redisFailed = true;
                }
            }
            if (redisFailed) {
                console.warn('⚠️ Feature flags loaded from DB into memory (Redis hydration failed)');
            } else {
                console.log('✅ Feature flags loaded from DB into memory & Redis');
            }
        } else {
            // Fallback for first run when DB is empty: read from Redis
            try {
                const keys = await redis.keys('feature_flag:*');
                for (const key of keys) {
                    const val = await redis.get(key);
                    const flagKey = key.replace('feature_flag:', '');
                    inMemoryFlags[flagKey] = val === 'true';
                }
                console.log('✅ Feature flags loaded from Redis into memory (DB empty)');
            } catch (redisErr) {
                console.warn('⚠️ Both DB and Redis are empty or unreachable for feature flags.');
            }
        }
    } catch (err) {
        console.error('🔥 Failed to load feature flags:', err.message);
    }
};

module.exports = {
    getFlags,
    updateFlagInMemory,
    initFlagsFromRedis
};
