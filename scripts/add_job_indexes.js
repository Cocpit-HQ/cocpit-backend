require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function addIndexes() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Created At (for main feed sort)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at 
      ON jobs(created_at DESC);
    `);

        // 2. Is Active (frequent filter)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_is_active 
      ON jobs(is_active);
    `);

        // 3. Recruiter ID (for My Jobs)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_recruiter_id 
      ON jobs(recruiter_id);
    `);

        // 4. Job Offers (is_offer filter)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_is_offer 
      ON jobs(is_offer) WHERE is_offer = TRUE;
    `);

        // 5. Saved Jobs (join speedup)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_saves_user_saved 
      ON job_saves(user_id, saved_at DESC);
    `);

        // 6. Applications (join speedup & my apps)
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_applications_applicant_applied 
      ON job_applications(applicant_id, applied_at DESC);
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_job_applications_job_applicant 
      ON job_applications(job_id, applicant_id);
    `);

        // 7. Filter Columns (common filters)
        // Basic B-tree indexes for equality checks
        await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_work_mode ON jobs(work_mode);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_experience_level ON jobs(experience_level);`);

        // 8. Trigram indexes for text search (title, location) -- Requires pg_trgm extension
        // We'll wrap in try/catch or check extension existence
        try {
            await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm 
        ON jobs USING GIN (title gin_trgm_ops);
      `);

            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_jobs_location_trgm 
        ON jobs USING GIN (location gin_trgm_ops);
      `);
            console.log('Trigram indexes created.');
        } catch (e) {
            console.warn('Could not create trigram indexes (pg_trgm might be missing permissions):', e.message);
            // Fallback to normal index for prefix search if needed, but ILIKE %...% won't use btree effectively
        }

        await client.query('COMMIT');
        console.log('Job indexes added successfully.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error adding indexes:', err);
    } finally {
        client.release();
        pool.end();
    }
}

addIndexes();
