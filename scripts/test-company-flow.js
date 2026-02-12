const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const http = require('http');
const app = require('../src/app');
const axios = require('axios');
const pool = require('../src/db/pool');

const PORT = 5002;
const API_URL = `http://localhost:${PORT}/api`;

let server;
let ownerToken;
let memberToken;
let ownerId;
let memberId;
let companyId;
const companySlug = 'test-company-' + Date.now();

async function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(PORT, () => {
            console.log(`Test server running on port ${PORT}`);
            resolve();
        });
    });
}

async function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

async function registerUser(email, name) {
    try {
        // Register (ignore return, as it lacks token)
        await axios.post(`${API_URL}/auth/register`, {
            email,
            password: 'password123',
            fullName: name,
            mobileNumber: '1234567890',
            accountType: 'Employer'
        });

        // Login to get token
        const loginRes = await axios.post(`${API_URL}/auth/login`, { email, password: 'password123' });
        return { token: loginRes.data.accessToken, id: loginRes.data.user.id };
    } catch (err) {
        // If already exists, login
        console.log(`Register failed for ${email} (likely exists), trying login...`);
        const loginRes = await axios.post(`${API_URL}/auth/login`, { email, password: 'password123' });
        return { token: loginRes.data.accessToken, id: loginRes.data.user.id };
    }
}

async function getIdFromEmail(email) {
    const res = await pool.query("SELECT user_id FROM users WHERE email = $1", [email]);
    return res.rows[0]?.user_id;
}

async function runTests() {
    try {
        await startServer();

        console.log("\n1. Setup Users...");
        const owner = await registerUser(`owner_${Date.now()}@test.com`, 'Owner User');
        ownerToken = owner.token;
        ownerId = owner.id;
        console.log(`   Owner ID: ${ownerId}`);

        const member = await registerUser(`member_${Date.now()}@test.com`, 'Member User');
        memberToken = member.token;
        memberId = member.id;
        console.log(`   Member ID: ${memberId}`);

        console.log("\n2. Check Slug Availability...");
        const slugRes = await axios.get(`${API_URL}/companies/check-slug?slug=${companySlug}`, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        console.log(`   Slug Available: ${slugRes.data.available}`);
        if (!slugRes.data.available) throw new Error("Slug should be available");

        console.log("\n3. Create Company...");
        const createRes = await axios.post(`${API_URL}/companies`, {
            name: "Test Company Inc.",
            slug: companySlug,
            email: "contact@testcompany.com",
            industry: "Tech",
            size: "1-10",
            website: "https://testcompany.com",
            location: "Remote"
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        companyId = createRes.data.company.company_id;
        console.log(`   Created Company ID: ${companyId}`);

        console.log("\n4. Get Company...");
        const getRes = await axios.get(`${API_URL}/companies/${companySlug}`);
        console.log(`   Fetched Company Name: ${getRes.data.name}`);
        if (getRes.data.name !== "Test Company Inc.") throw new Error("Name mismatch");

        console.log("\n5. Invite Member...");
        await axios.post(`${API_URL}/companies/${companyId}/members/invite`, {
            email: `member_${Date.now()}@test.com`, // Using a fresh email for invite to match logic but here we use member email
            role: 'ADMIN'
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        console.log("   Invite Sent.");

        console.log("\n6. Verify Domain...");
        const verifyRes = await axios.post(`${API_URL}/companies/${companyId}/verify/domain`, {
            domain: "testcompany.com"
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        console.log(`   OTP Generated: ${verifyRes.data.otp}`);

        console.log("\n7. Transfer Ownership...");
        await axios.post(`${API_URL}/companies/${companyId}/transfer-ownership`, {
            newOwnerId: memberId
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        console.log("   Ownership Transferred.");

        // Verification: Old owner should fail to verify domain now
        console.log("\n8. Verify Old Owner Restricted...");
        try {
            await axios.post(`${API_URL}/companies/${companyId}/verify/domain`, {
                domain: "testcompany.com"
            }, {
                headers: { Authorization: `Bearer ${ownerToken}` }
            });
            throw new Error("Old owner should NOT be able to verify domain");
        } catch (err) {
            if (err.response && err.response.status === 403) {
                console.log("   ✅ Correctly Forbidden (403)");
            } else {
                throw err;
            }
        }

        // New owner should be able to delete
        console.log("\n9. New Owner Deletes Company...");
        await axios.delete(`${API_URL}/companies/${companyId}`, {
            headers: { Authorization: `Bearer ${memberToken}` }
        });
        console.log("   Company Deleted.");

        // Verify Soft Delete
        try {
            await axios.get(`${API_URL}/companies/${companySlug}`);
            throw new Error("Deleted company should not be visible"); // Unless we allowed inactive lookup? Ctrl says `is_deleted = FALSE`
        } catch (err) {
            if (err.response && err.response.status === 404) {
                console.log("   ✅ Company Not Found (Soft Deleted)");
            } else {
                throw err;
            }
        }

        console.log("\n✅ ALL TESTS PASSED");

    } catch (err) {
        console.error("❌ Test Failed:", err.response ? JSON.stringify(err.response.data) : err.message);
        process.exit(1);
    } finally {
        await stopServer();
        // Cleanup pool
        await pool.end();
        process.exit(0);
    }
}

runTests();
