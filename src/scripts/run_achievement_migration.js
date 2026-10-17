require("dotenv").config();
const pool = require("../core/db/pool");
const fs = require("fs");
const path = require("path");

const runMigration = async () => {
    try {
        console.log("🚀 Running achievement_images migration...");
        const sqlPath = path.join(__dirname, "../db/feed-migrations/004_achievement_images.sql");
        const sql = fs.readFileSync(sqlPath, "utf8");
        
        await pool.query(sql);
        console.log("✅ Migration 004_achievement_images completed successfully");

        // Verify table
        const cols = await pool.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'achievement_images' ORDER BY ordinal_position"
        );
        console.log("\nachievement_images columns:");
        console.table(cols.rows);

        // Verify FK column on posts
        const postCol = await pool.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'achievement_image_id'"
        );
        console.log("posts.achievement_image_id column:");
        console.table(postCol.rows);

        process.exit(0);
    } catch (err) {
        console.error("❌ Migration failed:", err);
        process.exit(1);
    }
};

runMigration();
