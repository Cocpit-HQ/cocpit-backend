require("dotenv").config();
const pool = require("../core/db/pool");
const fs = require("fs");
const path = require("path");

const runMigration = async () => {
    try {
        console.log("🚀 Running institution_type backfill migration...");
        const sqlPath = path.join(__dirname, "../db/migration_institution_type_backfill.sql");
        const sql = fs.readFileSync(sqlPath, "utf8");

        const result = await pool.query(sql);
        console.log(`✅ Migration completed successfully — ${result.rowCount} row(s) updated`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Migration failed:", err);
        process.exit(1);
    }
};

runMigration();
