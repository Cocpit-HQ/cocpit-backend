const axios = require('axios');
const { signAccessToken } = require('./src/core/utils/jwt.js');

async function testPostLogic() {
    try {
        // 1. Generate Auth Token
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
        console.log("✅ Using existing Institution ID:", orgId);

        // 2_a. Test Posting - Valid Category (Announcement)
        console.log("\nAttempting to create POST: 'Announcement'...");
        try {
            const postRes1 = await axios.post("http://localhost:5000/api/post", {
                companyId: orgId, // this creates an org post
                content: "Welcome to Post Testing University!",
                category: "Announcement",
                visibility: "public"
            });
            console.log("✅ Announcement Post Created successfully!");
        } catch (e) {
            console.error("❌ Announcement Post failed:", e.response?.data || e.message);
        }

        // 2_b. Test Posting - Invalid Category (Update - for companies only)
        console.log("\nAttempting to create POST: 'Update'...");
        try {
            const postRes2 = await axios.post("http://localhost:5000/api/post", {
                companyId: orgId,
                content: "This shouldn't work",
                category: "Update",
                visibility: "public"
            });
            console.log("❌ Company post succeeded but should have failed!");
        } catch (e) {
            console.log("✅ Update Post failed properly:", e.response?.data?.message || e.message);
        }

        // 2_c. Test Posting - Unverified Institution Failure
        console.log("\nAttempting to create POST as UNVERIFIED institution...");
        try {
            const unverifiedOrgRes = await pool.query(
                "UPDATE organizations SET verification_status = 'UNVERIFIED' WHERE org_id = $1",
                [orgId]
            );

            const postRes3 = await axios.post("http://localhost:5000/api/post", {
                companyId: orgId,
                content: "This should fail due to lack of verification",
                category: "Announcement",
                visibility: "public"
            });
            console.log("❌ Post succeeded but should have failed (unverified)!");
        } catch (e) {
            console.log("✅ Unverified post failed properly:", e.response?.data?.message || e.message);
            // Restore verification status for subsequent tests
            await pool.query("UPDATE organizations SET verification_status = 'VERIFIED' WHERE org_id = $1", [orgId]);
        }

    } catch (err) {
        if (err.response) {
            console.error(`❌ API Error [${err.response.status}]:`, err.response.data);
        } else {
            console.error("❌ Error:", err.message);
        }
    }
}

testPostLogic();
