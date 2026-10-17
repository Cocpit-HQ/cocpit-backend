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
                'zRevRange': 'zrevrange',
                'zRevRangeWithScores': 'zrevrange',
                'zRangeWithScores': 'zrange',
                'zAdd': 'zadd',
                'zRem': 'zrem',
                'mGet': 'mget',
            };
            if (camelToSnake[prop]) {
                actualProp = camelToSnake[prop];
            } else if (prop.length > 1 && /^[slz][A-Z]/.test(prop)) {
                // Heuristic for set(s), list(l), and sorted set(z) commands: sAdd, lPush, zIncrBy, etc.
                actualProp = prop.toLowerCase();
            }
        }

        const val = target[actualProp];
        if (typeof val === 'function' && typeof prop === 'string') {
            return async (...args) => {
                // Transform zAdd({score, value}) object format to ioredis zadd(score, member) format
                if (prop === 'zAdd' && args.length >= 2) {
                    const key = args[0];
                    const members = args.slice(1);
                    const flatArgs = [key];
                    for (const m of members) {
                        if (m && typeof m === 'object' && 'score' in m && 'value' in m) {
                            flatArgs.push(m.score, m.value);
                        }
                    }
                    if (flatArgs.length > 1) {
                        args = flatArgs;
                    }
                }

                const isWithScores = prop.includes('WithScores') || args.includes('WITHSCORES') || args.includes('withscores');
                
                // Add WITHSCORES to arguments if it was a WithScores method call
                if (prop.includes('WithScores') && !args.map(a => String(a).toUpperCase()).includes('WITHSCORES')) {
                    args.push('WITHSCORES');
                }

                // Transform node-redis scan(cursor, {MATCH, COUNT}) to ioredis scan(cursor, 'MATCH', match, 'COUNT', count)
                if (prop === 'scan' && args.length === 2 && typeof args[1] === 'object') {
                    const options = args[1];
                    const flatArgs = [args[0]];
                    if (options.MATCH) flatArgs.push('MATCH', options.MATCH);
                    if (options.COUNT) flatArgs.push('COUNT', options.COUNT);
                    args = flatArgs;
                }

                try {
                    const result = await val.apply(target, args);

                    // Transform ioredis [val, score, val, score] into node-redis [{value, score}]
                    if (isWithScores && Array.isArray(result)) {
                        const transformed = [];
                        for (let i = 0; i < result.length; i += 2) {
                            transformed.push({
                                value: result[i],
                                score: parseFloat(result[i + 1])
                            });
                        }
                        return transformed;
                    }

                    // Transform ioredis scan result [cursor, keys] into node-redis {cursor, keys}
                    if (prop === 'scan' && Array.isArray(result)) {
                        return {
                            cursor: Number(result[0]),
                            keys: result[1]
                        };
                    }

                    return result;
                } catch (err) {
                    console.error(`[Redis Proxy] Error executing command '${actualProp}':`, err.message);
                    throw err;
                }
            };
        }
        return val;
    }
});

module.exports = proxy;
