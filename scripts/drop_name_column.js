require('dotenv').config();
const pool = require('../src/db/pool');

async function dropNameColumn() {
    try {
        const res = await pool.query(`
      ALTER TABLE conversations
      DROP COLUMN IF EXISTS name;
    `);
        console.log("Column 'name' dropped successfully.");
    } catch (err) {
        console.error("Error dropping column:", err);
    } finally {
        pool.end();
    }
}

dropNameColumn();
