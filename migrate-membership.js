require('dotenv').config();
const pool = require('./src/db/pool');

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Starting migration...');

        // 1. Drop the existing primary key constraint
        // The constraint name is usually conversation_participants_pkey
        await client.query(`
            ALTER TABLE conversation_participants 
            DROP CONSTRAINT IF EXISTS conversation_participants_pkey;
        `);
        console.log('Dropped old PK constraint');

        // 2. Add a new surrogate primary key
        // Check if participant_id already exists (idempotency)
        const checkCol = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='conversation_participants' AND column_name='participant_id'
        `);

        if (checkCol.rowCount === 0) {
            await client.query(`
                ALTER TABLE conversation_participants 
                ADD COLUMN participant_id UUID PRIMARY KEY DEFAULT gen_random_uuid();
            `);
            console.log('Added participant_id column');
        }

        // 3. Add an index for performance and to help ensure one active entry per user per group (optional but good)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cp_active_user 
            ON conversation_participants (conversation_id, user_id) 
            WHERE left_at IS NULL;
        `);
        console.log('Created active user index');

        await client.query('COMMIT');
        console.log('Migration successful!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        client.release();
    }
}

migrate().then(() => process.exit(0));
