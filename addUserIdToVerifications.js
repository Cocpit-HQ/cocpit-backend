require("dotenv").config();
const pool = require('./src/core/db/pool');

const run = async () => {
    try {
        await pool.query(`
            ALTER TABLE organization_verifications
            ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
            
            ALTER TABLE organization_verifications
            ALTER COLUMN org_id DROP NOT NULL;
        `);
        console.log("Migration successful");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

run();
