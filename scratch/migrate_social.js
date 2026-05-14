require('dotenv').config();
const pool = require('../src/core/db/pool');

const migrate = async () => {
    try {
        console.log('Starting migration...');
        
        // 1. Create table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_social_accounts (
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                provider VARCHAR(20) NOT NULL,
                provider_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (provider, provider_id)
            );
        `);
        console.log('Created user_social_accounts table.');

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_social_accounts_user_id ON user_social_accounts(user_id);
        `);
        console.log('Created index.');

        // 2. Migrate existing google accounts
        const result = await pool.query(`
            INSERT INTO user_social_accounts (user_id, provider, provider_id)
            SELECT user_id, 'google', google_id
            FROM users
            WHERE google_id IS NOT NULL
            ON CONFLICT (provider, provider_id) DO NOTHING;
        `);
        console.log(`Migrated ${result.rowCount} Google accounts.`);
        
        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
};

migrate();
