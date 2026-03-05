/**
 * Entity Resolver — Lightweight metadata preview with Redis caching
 *
 * Returns a unified preview shape for any entity:
 *   { entityType, entityId, title, subtitle, image, url }
 *
 * Supported: post, profile, company, job, event
 *
 * Cache key:  preview:{entityType}:{entityId}
 * TTL:        300 seconds (5 minutes)
 */

const redisClient = require("../../core/db/redis");
const postAdapter = require("./adapters/postAdapter");
const profileAdapter = require("./adapters/profileAdapter");
const companyAdapter = require("./adapters/companyAdapter");
const jobAdapter = require("./adapters/jobAdapter");
const eventAdapter = require("./adapters/eventAdapter");

const CACHE_TTL = 300; // seconds

// ─── Resolver Registry ──────────────────────────────────────

const RESOLVERS = {
    post: postAdapter.resolve,
    profile: profileAdapter.resolve,
    company: companyAdapter.resolve,
    job: jobAdapter.resolve,
    event: eventAdapter.resolve,
};

// ─── URL Generator ──────────────────────────────────────────

const URL_PATTERNS = {
    post: (id) => `/post/${id}`,
    profile: (id) => `/profile/${id}`,
    company: (id) => `/company/${id}`,
    job: (id) => `/jobs/${id}`,
    event: (id) => `/events/${id}`,
};

function generateEntityUrl(entityType, entityId) {
    const generator = URL_PATTERNS[entityType];
    return generator ? generator(entityId) : `/${entityType}/${entityId}`;
}

// ─── Main Resolver (Redis Cache → DB) ───────────────────────

/**
 * Resolve entity metadata.
 * Flow: Redis check → cache hit? return : query DB → store in Redis → return
 *
 * @param {string} entityType
 * @param {string} entityId
 * @returns {Promise<object|null>}
 */
async function resolveEntity(entityType, entityId) {
    const resolver = RESOLVERS[entityType];
    if (!resolver) return null;

    const cacheKey = `preview:${entityType}:${entityId}`;

    // 1. Check Redis
    try {
        if (redisClient.isOpen) {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[EntityResolver] Cache HIT → ${cacheKey}`);
                return JSON.parse(cached);
            }
        }
    } catch (err) {
        console.warn("[EntityResolver] Redis read error:", err.message);
    }

    // 2. Cache miss → query database
    const preview = await resolver(entityId);
    if (!preview) return null;

    // 3. Store in Redis
    try {
        if (redisClient.isOpen) {
            await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(preview));
            console.log(`[EntityResolver] Cache SET → ${cacheKey} (TTL ${CACHE_TTL}s)`);
        }
    } catch (err) {
        console.warn("[EntityResolver] Redis write error:", err.message);
    }

    return preview;
}

/**
 * Invalidate cached preview.
 */
async function invalidatePreview(entityType, entityId) {
    try {
        if (redisClient.isOpen) {
            await redisClient.del(`preview:${entityType}:${entityId}`);
        }
    } catch (err) {
        console.warn("[EntityResolver] Cache invalidation error:", err.message);
    }
}

/**
 * Resolve multiple entities in batch.
 * Handles Redis caching for each entity.
 *
 * @param {Array<{type: string, id: string}>} entities
 * @returns {Promise<Array<object>>}
 */
async function resolveBatch(entities) {
    const results = await Promise.all(
        entities.map(e => resolveEntity(e.type, e.id).catch(() => null))
    );
    return results.filter(Boolean);
}

module.exports = {
    resolveEntity,
    resolveBatch,
    invalidatePreview,
    generateEntityUrl,
    RESOLVERS,
};
