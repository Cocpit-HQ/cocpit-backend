require('dotenv').config();
const pool = require('../core/db/pool');

const migrate = async () => {
    console.log("🚀 Starting Intent Layer Migration...");
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log("🏗 Creating system_checkpoints table if not exists...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS system_checkpoints (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        console.log("🗑 Removing old intent tables if they exist...");
        await client.query('DROP TABLE IF EXISTS user_intent_scores CASCADE');
        await client.query('DROP TABLE IF EXISTS user_activities CASCADE');

        console.log("🏗 Creating user_activities table...");
        await client.query(`
            CREATE TABLE user_activities (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                action VARCHAR(50) NOT NULL,
                metadata JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        console.log("🏗 Creating user_intent_scores table...");
        await client.query(`
            CREATE TABLE user_intent_scores (
                user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
                job_seeker_score INT DEFAULT 0,
                creator_score INT DEFAULT 0,
                event_score INT DEFAULT 0,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        console.log("📊 Creating indexes...");
        await client.query('CREATE INDEX idx_user_activities_user_id ON user_activities(user_id)');

        await client.query('COMMIT');
        console.log("✅ Migration Successful! Tables are ready for testing.");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Migration Failed:", err.message);
    } finally {
        client.release();
        process.exit(0);
    }
};

migrate();
