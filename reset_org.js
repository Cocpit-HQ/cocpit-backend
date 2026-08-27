require('dotenv').config();
const pool = require('./src/core/db/pool');

async function reset() {
    try {
        const res = await pool.query("UPDATE organizations SET verification_status = 'UNVERIFIED' RETURNING org_id, name, verification_status");
        console.table(res.rows);
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
reset();
