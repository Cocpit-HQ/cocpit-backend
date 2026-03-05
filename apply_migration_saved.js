const pool = require('./src/core/db/pool');
async function run() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Add org_id to saved_post
        await client.query(`
      ALTER TABLE saved_post 
      ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE
    `);

        // Drop old unique constraint if it exists (user_id, post_id)
        // We need a new constraint that includes org_id properly.
        // However, some users might have saved posts without org_id.
        // If org_id is NULL, it's a personal save.

        // Check constraint name
        const constraints = await client.query(`
        SELECT conname 
        FROM pg_constraint 
        WHERE conrelid = 'saved_post'::regclass AND contype = 'u'
    `);

        for (const row of constraints.rows) {
            await client.query(`ALTER TABLE saved_post DROP CONSTRAINT ${row.conname}`);
        }

        // Add new unique constraint: (user_id, post_id, org_id) - but NULLs in unique constraints allow duplicates in some PG versions.
        // Better to use a partial index or a constraint that handles NULL org_id.
        // Actually, (user_id, post_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000')) unique would work.
        // Or just:
        await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS saved_post_user_post_org_idx 
        ON saved_post (user_id, post_id) 
        WHERE org_id IS NULL
    `);

        await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS saved_post_org_post_idx 
        ON saved_post (org_id, post_id) 
        WHERE org_id IS NOT NULL
    `);

        await client.query('COMMIT');
        console.log("Migration successful");
        process.exit(0);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Migration failed:", err);
        process.exit(1);
    } finally {
        client.release();
    }
}
run();
