const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:5000/api';
const ORG_ID = 'c2708009-137e-480f-91a2-b02a42e35014'; // Just Innovation
const RANDOM_ORG_ID = 'da3589b2-32a2-4a00-ab83-e18e0a811234'; // Random non-member Org

async function runTests() {
    const logs = [];

    logs.push(`# My Listings API Reference & Test Log\n`);
    logs.push(`This document logs the actual API requests and responses executed against the backend on behalf of **Swaroop Manade** (\`swaroopmanade@gmail.com\`). It serves as a reference for frontend developers.\n`);
    logs.push(`- **User**: Swaroop Manade`);
    logs.push(`- **Company**: Just Innovation (\`org_id: ${ORG_ID}\`)\n`);
    logs.push(`---\n`);

    let token = '';

    async function logRequest(stepName, method, url, payload, headers) {
        console.log(`Executing: ${stepName}`);
        logs.push(`## ${stepName}`);
        logs.push(`**Endpoint**: \`${method} ${url}\``);
        if (payload) {
            logs.push(`**Request Payload**:`);
            logs.push(`\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
        }
        
        try {
            const config = { method, url: `${BASE_URL}${url}` };
            if (payload) config.data = payload;
            if (headers) config.headers = headers;

            const res = await axios(config);
            
            logs.push(`**Response (Status: ${res.status})**:`);
            // Clean sensitive token in response logs
            let resData = res.data;
            if (resData.accessToken) {
                resData = { ...resData, accessToken: '<JWT_TOKEN>', refreshToken: '<REFRESH_TOKEN>' };
            }
            logs.push(`\`\`\`json\n${JSON.stringify(resData, null, 2)}\n\`\`\``);
            logs.push(`\n---\n`);
            return res.data;
        } catch (err) {
            const status = err.response ? err.response.status : 'Network Error';
            const data = err.response ? err.response.data : err.message;
            logs.push(`**Response (Status: ${status})**:`);
            logs.push(`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
            logs.push(`\n---\n`);
            return null;
        }
    }

    // 1. Login
    const loginRes = await logRequest(
        "1. Login as Swaroop",
        "POST",
        "/auth/login",
        { email: "swaroopmanade@gmail.com", password: "swaroop@123" }
    );
    if (!loginRes) {
        console.error("Login failed!");
        process.exit(1);
    }
    token = loginRes.accessToken;
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Fetch Individual Listings
    await logRequest(
        "2. Fetch Individual Listings (Must be empty initially or only show individual posts)",
        "GET",
        "/jobs/my",
        null,
        headers
    );

    // 3. Fetch Org Listings (Internal Scope) - Should Succeed (Member)
    await logRequest(
        "3. Fetch Org Listings (Internal Scope - Member)",
        "GET",
        `/organizations/${ORG_ID}/jobs?scope=internal`,
        null,
        headers
    );

    // 4. Fetch Org Listings (Internal Scope) - Should Fail (Non-Member)
    await logRequest(
        "4. Fetch Org Listings (Internal Scope - Non-Member)",
        "GET",
        `/organizations/${RANDOM_ORG_ID}/jobs?scope=internal`,
        null,
        headers
    );

    // 5. Create Individual Job Draft
    const draftRes = await logRequest(
        "5. Create Individual Job Draft",
        "POST",
        "/jobs",
        { title: "Individual Frontend Developer" },
        headers
    );

    // 6. Create Organization Job Draft
    await logRequest(
        "6. Create Organization Job Draft",
        "POST",
        `/organizations/${ORG_ID}/jobs`,
        {
            title: "Organization Lead Devops Engineer",
            status: "DRAFT",
            location: "Mumbai",
            job_type: "Full-time",
            work_mode: "Hybrid",
            experience_level: "Senior"
        },
        headers
    );

    // 7. Verify Listings are Separated
    await logRequest(
        "7. Verify Individual Listings (Should only return Individual Frontend Developer)",
        "GET",
        "/jobs/my",
        null,
        headers
    );

    await logRequest(
        "8. Verify Org Listings (Should return Organization Lead Devops Engineer)",
        "GET",
        `/organizations/${ORG_ID}/jobs?scope=internal`,
        null,
        headers
    );

    // Write logs to plans directory
    const targetDir = path.join(__dirname, '../plans/jobs/my-listings-api');
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(path.join(targetDir, 'api_reference.md'), logs.join('\n'));
    console.log("Tests complete! Log saved to plans/jobs/my-listings-api/api_reference.md");
    process.exit(0);
}

runTests();
