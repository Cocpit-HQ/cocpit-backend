require('dotenv').config();
const pool = require("./src/core/db/pool");
const fs = require("fs");
const path = require("path");

(async () => {
  try {
    const migrationsDir = path.join(__dirname, "migrations");
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      await pool.query(sql);
      console.log(`Applied migration: ${file}`);
    }

    console.log("All SQL migrations applied successfully.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
