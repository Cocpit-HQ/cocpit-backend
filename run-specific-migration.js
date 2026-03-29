require('dotenv').config();
const pool = require("./src/core/db/pool");
const fs = require("fs");
const path = require("path");

(async () => {
  const file = "20260329_create_report_system.sql";
  const migrationPath = path.join(__dirname, "migrations", file);
  
  try {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    console.log(`Applying migration: ${file}...`);
    await pool.query(sql);
    console.log(`Applied migration: ${file} successfully.`);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
})();
