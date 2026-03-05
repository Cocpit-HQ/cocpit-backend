require('dotenv').config();
const pool = require('./src/core/db/pool');

async function checkTables() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `);
        console.log('Tables in database:');
        res.rows.forEach(row => console.log(` - ${row.table_name}`));
    } catch (err) {
        console.error('Error checking tables:', err);
    } finally {
        client.release();
        process.exit();
    }
}

checkTables();
