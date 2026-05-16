require("dotenv").config();
const pool = require("./src/core/db/pool");

async function addColumn() {
    try {
        await pool.query("ALTER TABLE saved_folders ADD COLUMN IF NOT EXISTS cover_image TEXT;");
        console.log("Column 'cover_image' added successfully to 'saved_folders' table.");
        process.exit(0);
    } catch (err) {
        console.error("Error adding column:", err);
        process.exit(1);
    }
}

addColumn();
