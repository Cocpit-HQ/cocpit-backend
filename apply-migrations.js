require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./src/core/db/pool");

const migrationsDir = path.join(__dirname, "migrations");
const migrationFiles = [
  "20260330_add_hashtags.sql",
  "20260330_add_recommendation_scores.sql"
];

async function applyMigrations() {
  for (const filename of migrationFiles) {
    const filePath = path.join(migrationsDir, filename);
    console.log(`Applying migration: ${filename}...`);
    
    try {
      const sql = fs.readFileSync(filePath, "utf8");
      
      // We run the whole file as a single block for these specific migrations
      await pool.query(sql);
      
      console.log(`✅ ${filename} applied successfully.`);
    } catch (err) {
      console.error(`❌ Failed to apply ${filename}:`, err.message);
      // In a real system, we'd check if specific errors (like already exists) are okay
      if (err.message.includes("already exists")) {
        console.warn("   (Continuing as some elements already exist)");
      } else {
        process.exit(1);
      }
    }
  }
}

applyMigrations()
  .then(() => {
    console.log("All specified migrations processed.");
    process.exit(0);
  })
  .catch(err => {
    console.error("Migration fatal error:", err);
    process.exit(1);
  });
