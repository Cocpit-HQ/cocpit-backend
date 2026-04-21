require("dotenv").config();
const pool = require("../core/db/pool");
const fs = require("fs");
const path = require("path");

const runMigration = async () => {
    try {
        console.log("🚀 Running migration...");
        const sqlPath = path.join(__dirname, "../../migration_interests.sql");
        const sql = fs.readFileSync(sqlPath, "utf8");
        
        await pool.query(sql);
        console.log("✅ Migration completed successfully");
        process.exit(0);
    } catch (err) {
        console.error("❌ Migration failed:", err);
        process.exit(1);
    }
};

runMigration();
