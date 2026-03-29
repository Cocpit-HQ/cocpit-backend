require("dotenv").config();
const pool = require("./src/core/db/pool");

(async () => {
    try {
        const res = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        const tables = res.rows.map(r => r.table_name);
        console.log("Existing tables:", tables);

        // Check for 'hashtags' table and columns
        if (tables.includes('hashtags')) {
            const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'hashtags'`);
            console.log("Hashtags columns:", cols.rows.map(r => r.column_name));
        } else {
            console.log("MISSING: 'hashtags' table");
        }

        // Check for 'post_hashtags' table
        if (tables.includes('post_hashtags')) {
             const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'post_hashtags'`);
             console.log("Post_hashtags columns:", cols.rows.map(r => r.column_name));
        } else {
            console.log("MISSING: 'post_hashtags' table");
        }

        // Check for 'user_hashtag_scores' (added in recommendation_scores migration)
        if (tables.includes('user_hashtag_scores')) {
             console.log("User_hashtag_scores table exists.");
        } else {
            console.log("MISSING: 'user_hashtag_scores' table");
        }

        // Check for 'tickets' table
        if (tables.includes('tickets')) {
            console.log("Tickets table exists.");
            const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'`);
            console.log("Tickets columns:", cols.rows.map(r => r.column_name));
        } else {
            console.log("MISSING: 'tickets' table");
        }

        // Check for 'org_hierarchy' elements? (Check organization table for parent_org_id)
        const orgCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations'`);
        const orgColNames = orgCols.rows.map(r => r.column_name);
        if (orgColNames.includes('parent_org_id')) {
            console.log("Organization hierarchy columns exist.");
        } else {
            console.log("MISSING: Organization hierarchy columns (parent_org_id)");
        }

        // Check for 'reports' table (from create_report_system)
        if (tables.includes('reports')) {
            console.log("Reports table exists.");
        } else {
            console.log("MISSING: 'reports' table");
        }

        // Check for 'is_broadcast' index or column in posts
        const postCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'posts'`);
        const postColNames = postCols.rows.map(r => r.column_name);
        if (postColNames.includes('is_broadcast')) {
            console.log("Posts 'is_broadcast' column exists.");
        } else {
            console.log("MISSING: Posts 'is_broadcast' column");
        }

    } catch (err) {
        console.error("Database query failed:", err.message);
    } finally {
        process.exit(0);
    }
})();
