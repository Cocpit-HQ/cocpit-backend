require("dotenv").config();
const pool = require('./src/core/db/pool');

const sql = `
BEGIN;

-- Drop foreign key constraint first if it exists
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_location_id_fkey;

-- Drop location_id column
ALTER TABLE users DROP COLUMN IF EXISTS location_id;

-- Drop the legacy locations table
DROP TABLE IF EXISTS locations CASCADE;

COMMIT;
`;

async function run() {
  console.log("Running Phase 7 DB cleanup migration...");
  try {
    await pool.query(sql);
    console.log("Cleanup migration successful!");
  } catch (e) {
    console.error("Cleanup migration failed:", e);
  } finally {
    process.exit(0);
  }
}

run();
