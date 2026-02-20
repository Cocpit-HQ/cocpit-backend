require('dotenv').config();
const pool = require('./src/db/pool');

async function listColumns() {
    try {
        const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'stories'");
        console.log(res.rows.map(r => r.column_name));
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

listColumns();
