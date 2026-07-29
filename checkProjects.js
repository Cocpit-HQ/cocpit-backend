require("dotenv").config();
const pool = require("c:/Users/user2/Desktop/test/cocpit-backend/src/core/db/pool");

async function checkProjects() {
  try {
    const res = await pool.query("SELECT * FROM projects");
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkProjects();
