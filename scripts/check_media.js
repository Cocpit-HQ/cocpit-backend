require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function checkMedia() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT * FROM message_media ORDER BY created_at DESC LIMIT 1");
        if (res.rows.length > 0) {
            console.log("Latest Media Upload:");
            console.log(res.rows[0]);
        } else {
            console.log("No media found.");
        }
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        process.exit();
    }
}

checkMedia();
