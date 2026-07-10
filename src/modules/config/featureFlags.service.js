const redis = require('../../core/cache/redis');

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
        const keys = await redis.keys('feature_flag:*');
        for (const key of keys) {
            const val = await redis.get(key);
            const flagKey = key.replace('feature_flag:', '');
            inMemoryFlags[flagKey] = val === 'true';
        }
        console.log('✅ Feature flags loaded from Redis into memory');
    } catch (err) {
        console.error('🔥 Failed to load feature flags from Redis:', err.message);
    }
};

module.exports = {
    getFlags,
    updateFlagInMemory,
    initFlagsFromRedis
};
