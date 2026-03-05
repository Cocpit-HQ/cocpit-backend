require('dotenv').config();
const pool = require('./src/core/db/pool');

async function checkColumns(tableName) {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = $1
            ORDER BY ordinal_position;
        `, [tableName]);
        console.log(`Columns in ${tableName}:`);
        res.rows.forEach(row => console.log(` - ${row.column_name} (${row.data_type})`));
    } catch (err) {
        console.error(`Error checking columns for ${tableName}:`, err);
    } finally {
        client.release();
    }
}

async function run() {
    await checkColumns('companies');
    await checkColumns('posts');
    process.exit();
}

run();
