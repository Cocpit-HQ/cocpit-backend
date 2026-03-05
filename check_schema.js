const pool = require('./src/core/db/pool');
async function check() {
    try {
        const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'saved_folders'");
        console.log("Columns:", columns.rows.map(r => r.column_name));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
check();
