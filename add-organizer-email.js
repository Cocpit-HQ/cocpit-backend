require('dotenv').config();
const pool = require("./src/core/db/pool");

(async () => {
  try {
    await pool.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_email VARCHAR(255);
    `);
    console.log("Added organizer_email back to events table!");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
