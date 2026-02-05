yerequire('dotenv').config();
const pool = require('../src/db/pool');

async function fixGroupNames() {
    try {
        const res = await pool.query(`
      UPDATE conversations 
      SET name = conversation_name 
      WHERE is_group = true AND name IS NULL AND conversation_name IS NOT NULL
      RETURNING conversation_id, conversation_name, name
    `);
        console.log("Updated rows:", res.rows.length);
        console.log(res.rows);
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

fixGroupNames();
