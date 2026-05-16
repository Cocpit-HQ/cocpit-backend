require("dotenv").config();
const pool = require("./src/core/db/pool");

async function forceUpdate() {
    try {
        const coverImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const res = await pool.query(
            "UPDATE saved_folders SET cover_image = $1 WHERE name = 'cocpit' RETURNING *",
            [coverImage]
        );
        console.log("Updated 'cocpit' folder:", res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error("Error updating 'cocpit':", err);
        process.exit(1);
    }
}

forceUpdate();
