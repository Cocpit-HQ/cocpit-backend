const axios = require('axios');

const API_URL = 'http://localhost:5000/api';

async function testLogoutOthers() {
    try {
        console.log("1. Creating Session A...");
        const resA = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        });
        const tokenA = resA.data.accessToken;

        console.log("2. Creating Session B...");
        const resB = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        });
        const tokenB = resB.data.accessToken;

        console.log("3. Creating Session C (Target)...");
        const resC = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        });
        const tokenC = resC.data.accessToken;

        console.log("\n4. Checking active sessions (Expect >= 3)...");
        const listRes = await axios.get(`${API_URL}/auth/sessions`, {
            headers: { Authorization: `Bearer ${tokenC}` }
        });
        const initialCount = listRes.data.sessions.length;
        console.log(`   Found ${initialCount} sessions.`);

        if (initialCount < 3) {
            console.warn("⚠️ Warning: Less than 3 sessions found. Clean up might have happened?");
        }

        console.log("\n5. Terminating OTHER sessions (Keep C)...");
        const deleteRes = await axios.delete(`${API_URL}/auth/sessions`, {
            headers: { Authorization: `Bearer ${tokenC}` }
        });
        console.log("   API Response:", deleteRes.data);

        console.log("\n6. Verifying remaining sessions (Expect 1 matching C)...");
        const listResFinal = await axios.get(`${API_URL}/auth/sessions`, {
            headers: { Authorization: `Bearer ${tokenC}` }
        });

        const finalSessions = listResFinal.data.sessions;
        console.log(`   Found ${finalSessions.length} sessions.`);

        if (finalSessions.length === 1 && finalSessions[0].is_current === true) {
            console.log("✅ SUCCESS: Only the current session remains.");
        } else {
            console.error("❌ FAILED: Final session count is not 1 or is_current is false.");
            console.log(JSON.stringify(finalSessions, null, 2));
        }

        console.log("\n7. Verifying Session A is invalid (Optional - Requires access to verify endpoint, skipping for now)");
        // Ideally we would try to hit an endpoint with tokenA and expect 401/403, 
        // BUT access tokens are stateless and might still be valid for 15 mins.
        // We can only check if refresh token A is dead, but we don't have the refresh token cookie handy to test easily without a browser jar.


    } catch (error) {
        console.error("❌ Test Failed:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (error.response) console.error("Status:", error.response.status);
    }
}

testLogoutOthers();
