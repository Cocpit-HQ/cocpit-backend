const { Pool } = require('pg');
const pool = new Pool({
    host: '192.168.1.13',
    port: 5432,
    user: 'harshada',
    password: 'cocpit@4713',
    database: 'cocpit_backend'
});

async function check() {
    try {
        const res = await pool.query('SELECT COUNT(*) FROM post_impressions');
        console.log('Total Post Impressions:', res.rows[0].count);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
check();
