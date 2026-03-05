const axios = require('axios');
const { signAccessToken } = require('./src/core/utils/jwt.js');

async function testVerification() {
    try {
        const testUserId = '6761c039-1c93-4aa8-bf92-9286d7a384c4';
        const token = signAccessToken({
            sub: testUserId,
            email: 'test@gmail.com',
            userType: 'USER',
            status: 'ACTIVE'
        });
        axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        const pool = require('./src/core/db/pool.js');
        const orgRes = await pool.query("SELECT org_id FROM organizations WHERE name = 'Stanford University Test' LIMIT 1");
        const orgId = orgRes.rows[0].org_id;

        console.log("--- Testing EDU Email Verification ---");
        try {
            const eduRes = await axios.post(`http://localhost:5000/api/companies/${orgId}/verify/edu-email`, {
                email: 'dean@stanford.edu'
            });
            console.log("✅ EDU OTP Sent:", eduRes.data.otp);

            const confirmRes = await axios.post(`http://localhost:5000/api/companies/${orgId}/verify/edu-email`, {
                email: 'dean@stanford.edu',
                otp: eduRes.data.otp
            });
            console.log("✅ EDU Verification Success:", confirmRes.data.message);
        } catch (e) {
            console.error("❌ EDU Verification failed:", e.response?.data || e.message);
        }

        console.log("\n--- Testing Document Submission ---");
        try {
            const docRes = await axios.post(`http://localhost:5000/api/companies/${orgId}/verify/document`, {
                documentUrls: ['https://example.com/cert1.pdf', 'https://example.com/cert2.pdf']
            });
            console.log("✅ Document Submission Success:", docRes.data.message);
        } catch (e) {
            console.error("❌ Document Submission failed:", e.response?.data || e.message);
        }

        console.log("\n--- Testing Admin Queue & Review ---");
        // Generate Admin Token
        const adminToken = signAccessToken({
            sub: '879dad5f-a0c6-4bfb-9622-2bf4334ca8e6', // Real user ID from DB
            email: 'admin@cocpit.in',
            userType: 'USER',
            status: 'ACTIVE',
            roles: ['Admin'] // Assuming this helps if middleware checks roles array
        });

        // Wait, current requireRoles might check the token's role or DB.
        // Let's check requireRoles middleware logic.

        axios.defaults.headers.common['Authorization'] = `Bearer ${adminToken}`;

        try {
            const queueRes = await axios.get("http://localhost:5000/api/admin/verifications/queue");
            console.log("✅ Admin Queue Length:", queueRes.data.queue.length);

            if (queueRes.data.queue.length > 0) {
                const vId = queueRes.data.queue[0].verification_id;
                const reviewRes = await axios.put(`http://localhost:5000/api/admin/verifications/${vId}/review`, {
                    status: 'VERIFIED',
                    notes: 'Verified via test script'
                });
                console.log("✅ Admin Review Success:", reviewRes.data.message);
            }
        } catch (e) {
            console.error("❌ Admin Review failed:", e.response?.data || e.message);
        }

    } catch (err) {
        console.error("❌ Main Error:", err.message);
    }
}

testVerification();
