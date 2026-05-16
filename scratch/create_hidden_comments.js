const pool = require("../src/core/db/pool");

async function migrate() {
    const client = await pool.connect();
    try {
        console.log("Creating hidden_comments table...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS hidden_comments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
                comment_id UUID NOT NULL REFERENCES post_comments(comment_id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            -- Unique indexes to prevent duplicate hides per identity
            CREATE UNIQUE INDEX IF NOT EXISTS hidden_comments_user_idx ON hidden_comments (user_id, comment_id) WHERE org_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS hidden_comments_org_idx ON hidden_comments (org_id, comment_id) WHERE org_id IS NOT NULL;
        `);
        console.log("✅ Table 'hidden_comments' created successfully.");
    } catch (err) {
        console.error("❌ Migration failed:", err.message);
    } finally {
        client.release();
        process.exit();
    }
}

migrate();
