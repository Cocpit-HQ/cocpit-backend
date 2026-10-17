require('dotenv').config();
const pool = require('./src/core/db/pool');
async function run() {
  try {
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'post_comments'");
    console.log(res.rows);
  } finally {
    pool.end();
  }
}
run();
