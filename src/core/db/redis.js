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
        // Return property from masterRedis
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
    }
});

module.exports = proxy;
