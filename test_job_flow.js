const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'http://localhost:5000/api';
let token = '';
let jobId = '';

async function runFlow() {
    const logs = [];

    function logStep(step, req, res) {
        logs.push(`### ${step}`);
        if (req) {
            logs.push(`**Request:**`);
            logs.push(`\`\`\`json\n${JSON.stringify(req, null, 2)}\n\`\`\``);
        }
        if (res) {
            logs.push(`**Response:**`);
            logs.push(`\`\`\`json\n${JSON.stringify(res, null, 2)}\n\`\`\``);
        }
        logs.push(`---\n`);
    }

    try {
        console.log("1. Logging in...");
        const loginReq = { email: "rupa@gmail.com", password: "Rupa@123" };
        const loginRes = await axios.post(`${BASE_URL}/auth/login`, loginReq);
        token = loginRes.data.accessToken;
        // Cleanse token from logs for security
        const safeRes = { ...loginRes.data, accessToken: "<JWT_TOKEN>", refreshToken: "<REFRESH_TOKEN>" };
        logStep("1. Login (`POST /api/auth/login`)", loginReq, safeRes);

        console.log("2. Autocomplete Roles...");
        const roleRes = await axios.get(`${BASE_URL}/jobs/roles?q=Soft`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        logStep("2. Fetch Job Role Suggestions (`GET /api/jobs/roles?q=Soft`)", null, roleRes.data);

        console.log("3. Create Draft...");
        const createReq = { title: "Software Engineer - Full Stack" };
        const createRes = await axios.post(`${BASE_URL}/jobs`, createReq, {
            headers: { Authorization: `Bearer ${token}` }
        });
        jobId = createRes.data.job?.job_id;
        if (!jobId && createRes.data.data?.job_id) {
             jobId = createRes.data.data.job_id;
        }
        logStep("3. Initialize Draft (`POST /api/jobs`)", createReq, createRes.data);

        console.log("4. Patch Draft...");
        const fullJobData = {
            title: "Software Engineer - Full Stack",
            location: "Remote (India)",
            industry: "Technology",
            experience_min: 2,
            experience_max: 5,
            job_type: "Full-time",
            work_mode: "Remote",
            salary_min: 1500000,
            salary_max: 2500000,
            description: "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!"
        };

        const patchRes = await axios.patch(`${BASE_URL}/jobs/${jobId}`, fullJobData, {
            headers: { Authorization: `Bearer ${token}` }
        });
        logStep(`4. Autosave / Patch Draft (\`PATCH /api/jobs/${jobId}\`)`, fullJobData, patchRes.data);

        console.log("5. Publish Job...");
        const submitRes = await axios.post(`${BASE_URL}/jobs/${jobId}/submit`, fullJobData, {
            headers: { Authorization: `Bearer ${token}` }
        });
        logStep(`5. Publish Job (\`POST /api/jobs/${jobId}/submit\`)`, fullJobData, submitRes.data);

        console.log("6. Verify Explore API...");
        // Wait a small moment to ensure DB read handles it if there was a slight delay
        await new Promise(r => setTimeout(r, 500));
        const exploreRes = await axios.get(`${BASE_URL}/jobs?limit=5`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        // Find our job in the explore feed
        const ourJob = exploreRes.data?.find(j => j.job_id === jobId);
        logStep(`6. Verify on Explore API (\`GET /api/jobs?limit=5\`)`, null, {
            summary: `Fetched ${exploreRes.data?.length} jobs.`,
            foundOurJob: !!ourJob,
            jobData: ourJob || "Not found"
        });

        // Write to file
        fs.writeFileSync('flow_logs.md', logs.join('\n'));
        console.log("Flow completed successfully!");

    } catch (err) {
        console.error("Flow failed at some point.");
        if (err.response) {
            console.error("Status:", err.response.status);
            console.error("Data:", err.response.data);
            logStep(`ERROR`, err.config.data ? JSON.parse(err.config.data) : null, err.response.data);
        } else {
            console.error(err.message);
        }
        fs.writeFileSync('flow_logs.md', logs.join('\n'));
    }
}

runFlow();
