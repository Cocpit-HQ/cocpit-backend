require("dotenv").config();
const cloudinary = require("../src/config/cloudinary");
const pool = require("../src/db/pool");
const renderService = require("../src/services/render.service");

// Mock Metadata for Text Overlay
const MOCK_METADATA = {
    layers: [
        {
            type: 'text',
            content: 'VERIFICATION TEST',
            style: {
                color: '#ffffff',
                fontSize: 60,
                fontFamily: 'Arial',
                fontWeight: 'bold',
                gravity: 'center'
            }
        }
    ]
};

// Use a known public ID or just a placeholder for the test
// Ideally we should upload something, but let's assume one exists or upload a simple pixel/sample
// For verification, we can just use a sample image provided by Cloudinary if available, or upload a base64.
// Let's force an upload of a small image to be safe.
const SAMPLE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

async function verify() {
    const client = await pool.connect();
    let createdStoryId = null;
    let createdPublicId = null;

    try {
        console.log("1. Uploading sample image to Cloudinary...");
        const uploadRes = await cloudinary.uploader.upload(SAMPLE_IMAGE, {
            folder: "cocpit_stories_test",
            resource_type: "image"
        });
        createdPublicId = uploadRes.public_id;
        console.log("   Uploaded:", createdPublicId);

        console.log("2. Creating Dummy Story in DB...");
        // Need a user ID. Let's pick the first user.
        const userRes = await client.query("SELECT user_id FROM users LIMIT 1");
        if (userRes.rowCount === 0) throw new Error("No users found to assign story to.");
        const userId = userRes.rows[0].user_id;

        const storyRes = await client.query(`
            INSERT INTO stories (author_id, title, media_url, original_url, media_type, media_status, cld_public_id, story_metadata, expires_at)
            VALUES ($1, 'Verification Story', $2, $2, 'image', 'ready', $3, $4, now() + interval '1 hour')
            RETURNING story_id
        `, [userId, uploadRes.secure_url, createdPublicId, MOCK_METADATA]);

        createdStoryId = storyRes.rows[0].story_id;
        console.log("   Created Story ID:", createdStoryId);

        console.log("3. Triggering Backend Render...");
        const finalUrl = await renderService.renderStory(createdStoryId, createdPublicId, 'image', MOCK_METADATA);

        if (!finalUrl) throw new Error("Render service returned null URL");
        console.log("   Render Success! Final URL:", finalUrl);

        console.log("4. Verifying DB Update...");
        const checkRes = await client.query("SELECT render_status, final_url FROM stories WHERE story_id = $1", [createdStoryId]);
        const row = checkRes.rows[0];

        if (row.render_status !== 'ready') throw new Error(`DB status is ${row.render_status}, expected 'ready'`);
        if (row.final_url !== finalUrl) throw new Error("DB final_url does not match returned URL");

        console.log("   DB Verified: Status=ready, URL is saved.");

        console.log("\n✅ VERIFICATION SUCCESSFUL: Backend Rendering Logic is working.");
        console.log("   You can inspect the final URL in browser:", finalUrl);

    } catch (err) {
        console.error("\n❌ VERIFICATION FAILED:", err);
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

verify();
