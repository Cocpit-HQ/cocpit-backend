require('dotenv').config();
const pool = require("./src/core/db/pool");

(async () => {
  try {
    await pool.query(`
      ALTER TABLE events DROP COLUMN IF EXISTS organizer_name;
      ALTER TABLE events DROP COLUMN IF EXISTS organizer_email;
    `);
    console.log("Removed custom organizer columns from events table!");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
