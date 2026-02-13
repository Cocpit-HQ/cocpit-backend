require('dotenv').config();
const pool = require('../src/db/pool');

async function migrate() {
    const client = await pool.connect();
    try {
        console.log("Starting migration: Add company_id to jobs table...");
        await client.query("BEGIN");

        // 1. Add company_id column (Nullable initially)
        console.log("Adding company_id column...");
        await client.query(`
            ALTER TABLE jobs 
            ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;
        `);

        // 2. Backfill data
        console.log("Backfilling company_id from company_name...");
        const result = await client.query(`
            UPDATE jobs j
            SET company_id = c.company_id
            FROM companies c
            WHERE j.company_name = c.name
            AND j.company_id IS NULL;
        `);
        console.log(`Backfilled ${result.rowCount} jobs.`);

        // 3. Create Index
        console.log("Creating index...");
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
        `);

        await client.query("COMMIT");
        console.log("Migration successful!");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        process.exit();
    }
}

migrate();
