require('dotenv').config();
const pool = require('../core/db/pool');
const fs = require('fs');
const path = require('path');

const run = async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migration_experience_skills.sql'), 'utf-8');
    await pool.query(sql);
    console.log('Migration ran successfully');
  } catch (err) {
    console.error('Migration failed', err);
  } finally {
    process.exit(0);
  }
};

run();
