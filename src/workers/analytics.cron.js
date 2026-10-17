require('dotenv').config();
const pool = require("../core/db/pool");
const logger = require("../core/logger/logger");

/**
 * Analytics Cron Worker
 * Aggregates daily stats for profiles and posts from raw event tables.
 * Uses upsert (INSERT ... ON CONFLICT DO UPDATE) to ensure idempotency.
 */
const processAnalyticsAggregations = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            client.once('error', (err) => {
                logger.error("[AnalyticsCronWorker] Unexpected client error:", err.message);
            });
        } catch (connErr) {
            logger.warn("[AnalyticsCronWorker] Database connection unavailable. Skipping execution.");
            return;
        }

        logger.info("[AnalyticsCronWorker] Starting daily aggregations...");
        
        await client.query("BEGIN");

        // --- 1. AGGREGATE PROFILE ANALYTICS DAILY ---
        // Profile Views & Opportunity Views are stored in profile_views.
        // We aggregate data for the previous day (or current day up to now).
        // Since we want this to be idempotent and re-runnable, we can aggregate
        // the current date and the past few days to handle late-arriving events.
        const daysToProcess = 3; // Process today and the past 2 days

        for (let i = 0; i < daysToProcess; i++) {
            // Using parameterized interval for each day offset
            const dateStr = `CURRENT_DATE - INTERVAL '${i} days'`;

            logger.info(`[AnalyticsCronWorker] Aggregating Profile Analytics for ${dateStr}`);
            
            await client.query(`
                INSERT INTO profile_analytics_daily (
                    profile_owner_id,
                    profile_type,
                    date,
                    profile_views,
                    search_appearances,
                    new_followers,
                    new_connections
                )
                SELECT
                    owner_id,
                    owner_type,
                    agg_date,
                    SUM(views) as profile_views,
                    SUM(searches) as search_appearances,
                    SUM(followers) as new_followers,
                    SUM(connections) as new_connections
                FROM (
                    -- 1. Profile Views
                    SELECT 
                        profile_owner_id as owner_id, 
                        'user' as owner_type, -- TODO: Dynamic type if orgs have views
                        DATE(view_date) as agg_date,
                        COUNT(1) as views,
                        0 as searches,
                        0 as followers,
                        0 as connections
                    FROM profile_views
                    WHERE DATE(view_date) = DATE(${dateStr})
                      AND viewer_company_org_id IS NULL
                    GROUP BY profile_owner_id, DATE(view_date)

                    UNION ALL

                    -- 1.5. Organization Profile Views
                    SELECT 
                        profile_owner_id as owner_id, 
                        profile_type as owner_type,
                        DATE(viewed_at) as agg_date,
                        COUNT(1) as views,
                        0 as searches,
                        0 as followers,
                        0 as connections
                    FROM organization_profile_views
                    WHERE DATE(viewed_at) = DATE(${dateStr})
                    GROUP BY profile_owner_id, profile_type, DATE(viewed_at)

                    UNION ALL

                    -- 2. Search Appearances
                    SELECT 
                        profile_owner_id as owner_id,
                        profile_type as owner_type,
                        DATE(appearance_date) as agg_date,
                        0 as views,
                        COUNT(1) as searches,
                        0 as followers,
                        0 as connections
                    FROM search_appearances
                    WHERE DATE(appearance_date) = DATE(${dateStr})
                    GROUP BY profile_owner_id, profile_type, DATE(appearance_date)

                    UNION ALL

                    -- 3. Followers
                    SELECT 
                        following_id as owner_id,
                        'user' as owner_type,
                        DATE(created_at) as agg_date,
                        0 as views,
                        0 as searches,
                        COUNT(1) as followers,
                        0 as connections
                    FROM followers
                    WHERE DATE(created_at) = DATE(${dateStr})
                    GROUP BY following_id, DATE(created_at)

                    UNION ALL

                    -- 4. Connection Requests
                    SELECT 
                        receiver_id as owner_id,
                        'user' as owner_type,
                        DATE(created_at) as agg_date,
                        0 as views,
                        0 as searches,
                        0 as followers,
                        COUNT(1) as connections
                    FROM connection_requests
                    WHERE DATE(created_at) = DATE(${dateStr})
                    GROUP BY receiver_id, DATE(created_at)
                ) subquery
                GROUP BY owner_id, owner_type, agg_date
                ON CONFLICT (profile_owner_id, profile_type, date) DO UPDATE SET
                    profile_views = EXCLUDED.profile_views,
                    search_appearances = EXCLUDED.search_appearances,
                    new_followers = EXCLUDED.new_followers,
                    new_connections = EXCLUDED.new_connections;
            `);
            
            logger.info(`[AnalyticsCronWorker] Aggregating Post Analytics for ${dateStr}`);
            
            // --- 2. AGGREGATE POST ANALYTICS DAILY ---
            await client.query(`
                INSERT INTO post_analytics_daily (
                    post_id,
                    date,
                    impressions,
                    likes,
                    comments,
                    shares,
                    saves
                )
                SELECT
                    p_id,
                    agg_date,
                    SUM(imps) as impressions,
                    SUM(lks) as likes,
                    SUM(cmts) as comments,
                    SUM(shrs) as shares,
                    SUM(svs) as saves
                FROM (
                    -- Impressions (count distinct viewers per day; anonymous fallback by impression_id)
                    SELECT 
                        post_id as p_id,
                        DATE(view_date) as agg_date,
                        COUNT(DISTINCT COALESCE(viewer_org_id::text, viewer_id::text, impression_id::text)) as imps, 0 as lks, 0 as cmts, 0 as shrs, 0 as svs
                    FROM post_impressions
                    WHERE DATE(view_date) = DATE(${dateStr})
                    GROUP BY post_id, DATE(view_date)

                    UNION ALL

                    -- Likes
                    SELECT 
                        post_id as p_id,
                        DATE(created_at) as agg_date,
                        0 as imps, COUNT(1) as lks, 0 as cmts, 0 as shrs, 0 as svs
                    FROM post_likes
                    WHERE DATE(created_at) = DATE(${dateStr})
                    GROUP BY post_id, DATE(created_at)

                    UNION ALL

                    -- Comments
                    SELECT 
                        post_id as p_id,
                        DATE(created_at) as agg_date,
                        0 as imps, 0 as lks, COUNT(1) as cmts, 0 as shrs, 0 as svs
                    FROM post_comments
                    WHERE DATE(created_at) = DATE(${dateStr})
                    GROUP BY post_id, DATE(created_at)

                    UNION ALL

                    -- Shares
                    SELECT 
                        entity_id::uuid as p_id,
                        DATE(created_at) as agg_date,
                        0 as imps, 0 as lks, 0 as cmts, COUNT(1) as shrs, 0 as svs
                    FROM shares
                    WHERE entity_type = 'post' 
                      AND entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      AND DATE(created_at) = DATE(${dateStr})
                    GROUP BY entity_id, DATE(created_at)

                    UNION ALL

                    -- Reposts (Share to Feed / Story)
                    SELECT 
                        shared_post_id as p_id,
                        DATE(created_at) as agg_date,
                        0 as imps, 0 as lks, 0 as cmts, COUNT(1) as shrs, 0 as svs
                    FROM posts
                    WHERE shared_post_id IS NOT NULL 
                      AND DATE(created_at) = DATE(${dateStr})
                    GROUP BY shared_post_id, DATE(created_at)

                    UNION ALL

                    -- Saves (count distinct users who saved the post that day)
                    SELECT 
                        post_id as p_id,
                        DATE(saved_at) as agg_date,
                        0 as imps, 0 as lks, 0 as cmts, 0 as shrs, COUNT(DISTINCT user_id) as svs
                    FROM saved_post
                    WHERE DATE(saved_at) = DATE(${dateStr})
                    GROUP BY post_id, DATE(saved_at)
                ) subquery
                WHERE p_id IS NOT NULL 
                  AND EXISTS (SELECT 1 FROM posts WHERE posts.post_id = p_id)
                GROUP BY p_id, agg_date
                ON CONFLICT (post_id, date) DO UPDATE SET
                    impressions = EXCLUDED.impressions,
                    likes = EXCLUDED.likes,
                    comments = EXCLUDED.comments,
                    shares = EXCLUDED.shares,
                    saves = EXCLUDED.saves;
            `);
        }

        await client.query("COMMIT");
        logger.info("[AnalyticsCronWorker] Aggregations completed successfully.");
    } catch (err) {
        if (client) await client.query("ROLLBACK");
        logger.error("[AnalyticsCronWorker] Error processing aggregations:", err);
    } finally {
        if (client) client.release();
    }
};

// Exported wrapper for manual triggering during testing
const runCronNow = async () => {
    await processAnalyticsAggregations();
};

// If run directly via node, run once. If required elsewhere, can be scheduled.
if (require.main === module) {
    processAnalyticsAggregations().then(() => process.exit(0));
}

module.exports = { processAnalyticsAggregations, runCronNow };
