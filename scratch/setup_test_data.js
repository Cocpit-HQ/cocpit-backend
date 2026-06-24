const pool = require('../src/core/db/pool');

async function checkData() {
  const client = await pool.connect();
  try {
    const userRes = await client.query(`SELECT user_id FROM users WHERE email = 'swaroopmanade@gmail.com'`);
    if (userRes.rowCount === 0) {
      console.log('User not found');
      return;
    }
    const userId = userRes.rows[0].user_id;
    console.log('User ID:', userId);

    // Find jobs owned by this user or their orgs
    const jobsRes = await client.query(`
      SELECT j.job_id, j.title 
      FROM jobs j
      LEFT JOIN organization_members om ON j.org_id = om.org_id AND om.user_id = $1
      WHERE j.recruiter_id = $1 OR om.user_id IS NOT NULL
      LIMIT 1
    `, [userId]);

    let jobId;
    if (jobsRes.rowCount > 0) {
      jobId = jobsRes.rows[0].job_id;
      console.log('Found Job:', jobsRes.rows[0]);
    } else {
      console.log('No jobs found for user. Creating a dummy job...');
      const insertJob = await client.query(`
        INSERT INTO jobs (recruiter_id, title, company_name, industry, status)
        VALUES ($1, 'Test Job for APIs', 'Test Co', 'IT', 'ACTIVE')
        RETURNING job_id
      `, [userId]);
      jobId = insertJob.rows[0].job_id;
      console.log('Created Job:', jobId);
    }

    // Check applications for this job
    const appsRes = await client.query(`
      SELECT application_id FROM job_applications WHERE job_id = $1 LIMIT 1
    `, [jobId]);

    let appId;
    if (appsRes.rowCount > 0) {
      appId = appsRes.rows[0].application_id;
      console.log('Found Application:', appId);
    } else {
      console.log('No applications found. Creating a dummy application...');
      // Need a dummy user for the applicant
      const dummyUserRes = await client.query(`
        INSERT INTO users (email, full_name, password_hash)
        VALUES ('dummy_applicant_${Date.now()}@example.com', 'Dummy Applicant', 'hash')
        RETURNING user_id
      `);
      const applicantId = dummyUserRes.rows[0].user_id;

      const insertApp = await client.query(`
        INSERT INTO job_applications (job_id, applicant_id, full_name, email, resume_url)
        VALUES ($1, $2, 'Dummy Applicant', 'dummy@example.com', 'http://example.com/resume.pdf')
        RETURNING application_id
      `, [jobId, applicantId]);
      appId = insertApp.rows[0].application_id;
      console.log('Created Application:', appId);
    }

    console.log('\n--- Test Data Setup Complete ---');
    console.log(`JOB_ID=${jobId}`);
    console.log(`APPLICATION_ID=${appId}`);

  } finally {
    client.release();
    process.exit(0);
  }
}

checkData().catch(console.error);
