const pool = require('./src/core/db/pool');
async function run() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Add org_id to saved_folders
        await client.query(`
      ALTER TABLE saved_folders 
      ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE
    `);

        // Drop old unique constraint if it exists (user_id, name)
        const constraints = await client.query(`
        SELECT conname 
        FROM pg_constraint 
        WHERE conrelid = 'saved_folders'::regclass AND contype = 'u'
    `);

        for (const row of constraints.rows) {
            await client.query(`ALTER TABLE saved_folders DROP CONSTRAINT ${row.conname}`);
        }

        // Add new unique index/constraints
        await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS saved_folders_user_name_idx 
        ON saved_folders (user_id, name) 
        WHERE org_id IS NULL
    `);

        await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS saved_folders_org_name_idx 
        ON saved_folders (org_id, name) 
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
