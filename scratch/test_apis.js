require('dotenv').config();
const pool = require('../src/core/db/pool');

const EMAIL = 'swaroopmanade@gmail.com';
const PASSWORD = 'swaroop@123';
const BASE_URL = 'http://localhost:5000/api'; // updated to correct port

async function runTests() {
  console.log(`\n=== 1. Logging in as ${EMAIL} ===`);
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });

  if (!loginRes.ok) {
    console.error('Login failed:', await loginRes.text());
    process.exit(1);
  }

  const { accessToken, user } = await loginRes.json();
  console.log('Login successful. User ID:', user.id);
  const authHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const client = await pool.connect();
  let jobId, applicationId;
  try {
    console.log('\n=== 2. Finding or creating test data ===');
    // Find a job
    const jobRes = await client.query(`
      SELECT job_id FROM jobs 
      WHERE recruiter_id = $1 OR org_id IN (
        SELECT org_id FROM organization_members WHERE user_id = $1
      ) LIMIT 1
    `, [user.id]);

    if (jobRes.rowCount > 0) {
      jobId = jobRes.rows[0].job_id;
      console.log('Found Job:', jobId);
    } else {
      const iJob = await client.query(`
        INSERT INTO jobs (recruiter_id, title, company_name, industry, status)
        VALUES ($1, 'API Test Job', 'Test Co', 'IT', 'ACTIVE') RETURNING job_id
      `, [user.id]);
      jobId = iJob.rows[0].job_id;
      console.log('Created Job:', jobId);
    }

    // Find an application
    const appRes = await client.query(`SELECT application_id FROM job_applications WHERE job_id = $1 LIMIT 1`, [jobId]);
    if (appRes.rowCount > 0) {
      applicationId = appRes.rows[0].application_id;
      console.log('Found Application:', applicationId);
    } else {
      const dUser = await client.query(`
        INSERT INTO users (email, full_name, password_hash)
        VALUES ('dummy${Date.now()}@test.com', 'Dummy Applicant', 'hash') RETURNING user_id
      `);
      const applicantId = dUser.rows[0].user_id;
      const iApp = await client.query(`
        INSERT INTO job_applications (job_id, applicant_id, full_name, email, resume_url)
        VALUES ($1, $2, 'Dummy Applicant', 'dummy@test.com', 'http://resume.pdf') RETURNING application_id
      `, [jobId, applicantId]);
      applicationId = iApp.rows[0].application_id;
      console.log('Created Application:', applicationId);
    }
  } finally {
    client.release();
  }

  console.log('\n=== 3. Testing GET /jobs/:id/applicants (Lightweight List) ===');
  const resList = await fetch(`${BASE_URL}/jobs/${jobId}/applicants`, { headers: authHeaders });
  console.log(`Status: ${resList.status}`);
  const dataList = await resList.json();
  console.log('Response:', JSON.stringify(dataList, null, 2));

  console.log('\n=== 4. Testing GET /jobs/applications/:id (Detail) ===');
  const resDetail = await fetch(`${BASE_URL}/jobs/applications/${applicationId}`, { headers: authHeaders });
  console.log(`Status: ${resDetail.status}`);
  console.log('Response:', JSON.stringify(await resDetail.json(), null, 2));

  console.log('\n=== 5. Testing PUT /jobs/applications/:id/status ===');
  const resStatus = await fetch(`${BASE_URL}/jobs/applications/${applicationId}/status`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ status: 'Shortlisted' })
  });
  console.log(`Status: ${resStatus.status}`);
  console.log('Response:', JSON.stringify(await resStatus.json(), null, 2));

  console.log('\n=== 6. Testing PUT /jobs/applications/:id/note ===');
  const resNote = await fetch(`${BASE_URL}/jobs/applications/${applicationId}/note`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ body: 'Testing a recruiter note added via API.' })
  });
  console.log(`Status: ${resNote.status}`);
  console.log('Response:', JSON.stringify(await resNote.json(), null, 2));

  console.log('\n=== 7. Testing GET /jobs/applications/:id/analysis ===');
  const resAnalysis = await fetch(`${BASE_URL}/jobs/applications/${applicationId}/analysis`, { headers: authHeaders });
  console.log(`Status: ${resAnalysis.status}`);
  console.log('Response:', JSON.stringify(await resAnalysis.json(), null, 2));

  console.log('\n=== 8. Testing POST /jobs/applications/:id/analyze (Stub) ===');
  const resAnalyze = await fetch(`${BASE_URL}/jobs/applications/${applicationId}/analyze`, { method: 'POST', headers: authHeaders });
  console.log(`Status: ${resAnalyze.status}`);
  console.log('Response:', JSON.stringify(await resAnalyze.json(), null, 2));

  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
