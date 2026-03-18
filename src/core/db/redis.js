const masterRedis = require("../cache/redis");

/**
 * Compatibility Proxy for node-redis
 * This ensures all components use a single, throttled, exponential-backoff client.
 */
const proxy = new Proxy(masterRedis, {
    get(target, prop) {
        if (prop === 'isOpen') {
            return target.status === 'ready';
        }
        if (prop === 'connect') {
            return async () => { /* Already handled by master auto-connect */ };
        }

        // Handle node-redis v4+ camelCase mapping to ioredis lowercase
        let actualProp = prop;
        if (typeof prop === 'string') {
            const camelToSnake = {
                'sAdd': 'sadd',
                'sMembers': 'smembers',
                'sRem': 'srem',
                'sIsMember': 'sismember',
                'setEx': 'setex',
                'pSetEx': 'psetex',
                'del': 'del',
                'hSet': 'hset',
                'hGet': 'hget',
                'hGetAll': 'hgetall',
                'hDel': 'hdel',
            };
            if (camelToSnake[prop]) {
                actualProp = camelToSnake[prop];
            } else if (prop.length > 1 && prop.startsWith('s') && prop[1] === prop[1].toUpperCase()) {
                // Heuristic for set commands: sAdd, sMembers, etc.
                actualProp = prop.toLowerCase();
            }
        }

        const val = target[actualProp];
        return typeof val === 'function' ? val.bind(target) : val;
    }
});

module.exports = proxy;
