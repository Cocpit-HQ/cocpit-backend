require("dotenv").config();
const pool = require('./src/core/db/pool');

const sql = `
BEGIN;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_country   TEXT,
  ADD COLUMN IF NOT EXISTS location_state     TEXT,
  ADD COLUMN IF NOT EXISTS location_city      TEXT,
  ADD COLUMN IF NOT EXISTS location_formatted TEXT,
  ADD COLUMN IF NOT EXISTS location_lat       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lng       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_place_id  TEXT;
CREATE INDEX IF NOT EXISTS idx_users_location_country ON users(location_country) WHERE location_country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_location_city ON users(LOWER(location_city)) WHERE location_city IS NOT NULL;
COMMIT;
`;

async function run() {
  console.log("Running Phase 3 DB migration...");
  try {
    await pool.query(sql);
    console.log("Migration successful!");
  } catch (e) {
    console.error("Migration failed:", e);
  } finally {
    process.exit(0);
  }
}

run();
