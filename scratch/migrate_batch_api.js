const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

const migrate = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding version column to profiles...');
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='version') THEN
                    ALTER TABLE profiles ADD COLUMN version INTEGER DEFAULT 1;
                END IF;
            END $$;
        `);

        console.log('Creating idempotent_requests table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS idempotent_requests (
                request_id TEXT PRIMARY KEY,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                response_body JSONB,
                status_code INTEGER,
                created_at TIMESTAMPTZ DEFAULT now(),
                expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
            );
        `);

        await client.query('CREATE INDEX IF NOT EXISTS idx_idempotent_requests_user_id ON idempotent_requests(user_id);');

        await client.query('COMMIT');
        console.log('Migration successful!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
};

migrate();
