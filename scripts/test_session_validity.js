const axios = require('axios');

const API_URL = 'http://localhost:5000/api';

async function testSessionValidity() {
    try {
        console.log("1. Creating Session A (Victim)...");
        const resA = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        });
        const tokenA = resA.data.accessToken;

        console.log("2. Creating Session B (Assailant)...");
        const resB = await axios.post(`${API_URL}/auth/login`, {
            email: "test_session_user@example.com",
            password: "password123"
        });
        const tokenB = resB.data.accessToken;

        console.log("3. Token A before logout (PUT identity): expecting 200");
        await axios.put(`${API_URL}/profile/identity`, {
            open_to: "Full-time",
            availability: "Immediate",
            work_preference: "Remote"
        }, {
            headers: { Authorization: `Bearer ${tokenA}` }
        });
        console.log("   ✅ SUCCESS: Token A worked.");

        console.log("4. Terminating other sessions using Session B...");
        await axios.delete(`${API_URL}/auth/sessions`, {
            headers: { Authorization: `Bearer ${tokenB}` }
        });

        console.log("5. Token A after logout (PUT identity): expecting 401");
        try {
            await axios.put(`${API_URL}/profile/identity`, {
                open_to: "Full-time",
                availability: "Immediate",
                work_preference: "Remote"
            }, {
                headers: { Authorization: `Bearer ${tokenA}` }
            });
            console.error("   ❌ FAILED: Token A still works!");
        } catch (error) {
            if (error.response && error.response.status === 401) {
                console.log("   ✅ SUCCESS: Token A rejected (401).");
            } else {
                console.error("   ❌ FAILED: Unexpected error:", error.message);
            }
        }

        console.log("6. Token B after logout (PUT identity): expecting 200");
        await axios.put(`${API_URL}/profile/identity`, {
            open_to: "Full-time",
            availability: "Immediate",
            work_preference: "Remote"
        }, {
            headers: { Authorization: `Bearer ${tokenB}` }
        });
        console.log("   ✅ SUCCESS: Token B still works.");

        console.log("\n7. Testing Token B AFTER logout (CRITICAL action - PUT identity)...");
        try {
            await axios.put(`${API_URL}/profile/identity`, {
                open_to: "Full-time",
                availability: "Immediate",
                work_preference: "Remote"
            }, {
                headers: { Authorization: `Bearer ${tokenB}` }
            });
            console.log("   ✅ SUCCESS: Token B (current) still works.");
        } catch (error) {
            console.error("   ❌ FAILED: Token B (current) should still work!", error.response ? error.response.data : error.message);
        }

    } catch (error) {
        console.error("❌ Test Script Failed:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    }
}

testSessionValidity();
