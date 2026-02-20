require("dotenv").config();
const pool = require("../src/db/pool");

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        console.log("Creating saved_post table...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS saved_post(
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
                saved_at TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (user_id , post_id)
            );
        `);

        console.log("Seeding post categories...");
        // Ensure post_categories table exists? 
        // Assuming it exists as per schema.sql structure, but just in case we can create it if not.
        // schema.sql defines it as: 
        /*
        CREATE TABLE post_categories (
          category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT UNIQUE NOT NULL
        );
        */
        // But if it exists, we just insert.

        await client.query(`
            INSERT INTO post_categories (name) VALUES 
            ('Personal'),
            ('Professional'),
            ('Achievement'),
            ('Update'),
            ('Hiring'),
            ('Milestone'),
            ('Insight')
            ON CONFLICT (name) DO NOTHING;
        `);

        await client.query("COMMIT");
        console.log("Migration successful");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
