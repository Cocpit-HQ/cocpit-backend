require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function listUsers() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT user_id, full_name, email FROM users LIMIT 5");
        console.log("Available Users:");
        res.rows.forEach(u => {
            console.log(`- Name: ${u.full_name}, Email: ${u.email}, ID: ${u.user_id}`);
        });
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        process.exit();
    }
}

listUsers();
