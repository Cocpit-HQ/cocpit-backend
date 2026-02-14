require('dotenv').config();
const pool = require('./src/db/pool');

async function checkSchema() {
    try {
        const res = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'conversation_participants'
      ORDER BY ordinal_position
    `);
        console.log("Schema of conversation_participants:");
        console.table(res.rows);

        const res2 = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'conversations'
      ORDER BY ordinal_position
    `);
        console.log("\nSchema of conversations:");
        console.table(res2.rows);

    } catch (err) {
        console.error("Failed to check schema:", err);
    } finally {
        await pool.end();
    }
}

checkSchema();
