require('dotenv').config();
const pool = require('../src/core/db/pool');

async function checkDb() {
  try {
    const { rows } = await pool.query('SELECT max(created_at) FROM posts');
    console.log('Most recent post:', rows[0].max);
  } catch (err) {
    console.error('Debug script failed:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

checkDb();
