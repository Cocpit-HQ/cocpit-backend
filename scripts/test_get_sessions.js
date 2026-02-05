const axios = require('axios');

const API_URL = 'http://localhost:5000/api';

async function testGetSessions() {
    try {
        console.log("1. Logging in...");
        // Use a test user credentials - assuming these exist or adjust as needed
        // If this user doesn't exist, register it first manually or use an existing one
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        }).catch(async (err) => {
            if (err.response && err.response.status === 401) {
                console.log("User not found, registering...");
                await axios.post(`${API_URL}/auth/register`, {
                    email: "test_session_user@example.com",
                    password: "password123",
                    fullName: "Test Session User",
                    accountType: "Student"
                });
                return await axios.post(`${API_URL}/auth/login`, {
                    email: "test_session_user@example.com",
                    password: "password123"
                });
            }
            throw err;
        });

        const accessToken = loginRes.data.accessToken;
        console.log("Login successful. Token acquired.");

        console.log("\n2. Fetching Sessions...");
        const sessionsRes = await axios.get(`${API_URL}/auth/sessions`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        console.log("Sessions retrieved:", sessionsRes.data.sessions.length);

        const sessions = sessionsRes.data.sessions;
        if (!Array.isArray(sessions)) {
            console.error("❌ FAILED: 'sessions' is not an array");
            return;
        }

        const currentSession = sessions.find(s => s.is_current === true);
        if (currentSession) {
            console.log("✅ FOUND current session:", currentSession.session_id);
            console.log("   User Agent:", currentSession.user_agent);
            console.log("   IP:", currentSession.ip_address);
        } else {
            console.error("❌ FAILED: strictly current session not marked as is_current:true");
        }

        sessions.forEach(s => {
            if (s.token_hash || s.refresh_token) {
                console.error("❌ FAILED: Security leak! returned token hash or refresh token");
            }
        });

        console.log("\n✅ Test Completed Successfully");

    } catch (error) {
        console.error("❌ Test Failed:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (error.response) console.error("Status:", error.response.status);
    }
}

testGetSessions();
