require("dotenv").config();
const pool = require("./src/core/db/pool");

async function testCreate() {
    try {
        const userId = 'e8d559d4-d606-4dbe-86bc-c8fddb3caed3'; // From myyy folder
        const name = 'test_folder_' + Date.now();
        const coverImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        
        const res = await pool.query(
            "INSERT INTO saved_folders (user_id, org_id, name, cover_image) VALUES ($1, $2, $3, $4) RETURNING *",
            [userId, null, name, coverImage]
        );
        console.log("Created test folder:", res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error("Error creating test folder:", err);
        process.exit(1);
    }
}

testCreate();
