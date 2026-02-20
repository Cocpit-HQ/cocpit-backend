require("dotenv").config();
const axios = require("axios");
const cloudinary = require("../src/config/cloudinary");
const pool = require("../src/db/pool");
const { signAccessToken } = require("../src/utils/jwt");

// Config
const API_URL = "http://localhost:5001/api";
const SAMPLE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

// Mock Metadata for Text Overlay
const MOCK_METADATA = {
    layers: [
        {
            type: 'text',
            content: 'API TEST',
            style: {
                color: '#ff0000',
                fontSize: 50,
                fontFamily: 'Verdana',
                gravity: 'north'
            }
        }
    ]
};

async function testApiFlow() {
    const client = await pool.connect();
    let createdStoryId = null;
    let createdPublicId = null;
    let userId = null;

    try {
        console.log("1. Setup: Getting User and Token...");
        const userRes = await client.query("SELECT user_id FROM users LIMIT 1");
        if (userRes.rowCount === 0) throw new Error("No users found.");
        userId = userRes.rows[0].user_id;

        // Generate Token
        const token = signAccessToken({ sub: userId });
        console.log("   User ID:", userId);
        console.log("   Token Generated.");

        console.log("2. Uploading sample image to Cloudinary...");
        const uploadRes = await cloudinary.uploader.upload(SAMPLE_IMAGE, {
            folder: "cocpit_stories_api_test",
            resource_type: "image"
        });
        createdPublicId = uploadRes.public_id;
        console.log("   Uploaded Public ID:", createdPublicId);

        console.log("3. Calling POST /api/content/story...");
        const payload = {
            title: "API Verification Story",
            media_url: uploadRes.secure_url,
            media_type: "image",
            public_id: createdPublicId,
            media_status: "ready",
            story_metadata: MOCK_METADATA
        };

        const response = await axios.post(`${API_URL}/story`, payload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.status !== 201) throw new Error(`API returned status ${response.status}`);
        createdStoryId = response.data.story_id;
        console.log("   Story Created via API. ID:", createdStoryId);

        console.log("4. Polling for Render Completion...");
        let attempts = 0;
        let finalUrl = null;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            attempts++;
            await new Promise(r => setTimeout(r, 2000)); // Wait 2s

            const checkRes = await client.query("SELECT render_status, final_url FROM stories WHERE story_id = $1", [createdStoryId]);
            const row = checkRes.rows[0];

            console.log(`   Attempt ${attempts}: Status = ${row.render_status}`);

            if (row.render_status === 'ready') {
                finalUrl = row.final_url;
                break;
            } else if (row.render_status === 'failed') {
                throw new Error("Render status became 'failed'");
            }
        }

        if (!finalUrl) throw new Error("Render timed out or failed to become 'ready'");
        console.log("   Render Complete! Final URL:", finalUrl);

        console.log("5. Verifying Cloudinary Transformation Parameters...");
        // Check for specific layer parameters in the URL
        // Expected: l_text:Verdana_50:API%20TEST,co_rgb:ff0000,g_north
        // Note: URL encoding might vary, so checking substrings is safer

        const checks = [
            "l_text",
            "API%20TEST", // Encoded content
            "co_rgb:ff0000",
            "g_north"
        ];

        checks.forEach(check => {
            if (!finalUrl.includes(check)) {
                throw new Error(`Final URL missing expected parameter: ${check}`);
            }
        });

        console.log("   ✅ URL Verification Passed: Contains expected transformation params.");
        console.log("\n✅ API FLOW VERIFICATION SUCCESSFUL");

    } catch (err) {
        console.error("\n❌ API TEST FAILED:", err.response ? err.response.data : err.message);
        if (err.response) console.error("Status:", err.response.status);
    } finally {
        // Cleanup
        if (createdStoryId) {
            console.log("Cleaning up DB story...");
            await client.query("DELETE FROM stories WHERE story_id = $1", [createdStoryId]);
        }
        if (createdPublicId) {
            console.log("Cleaning up Cloudinary asset...");
            await cloudinary.uploader.destroy(createdPublicId);
        }
        client.release();
        await pool.end();
    }
}

testApiFlow();
