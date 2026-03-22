require('dotenv').config();
const pool = require("./src/core/db/pool");
const shareController = require("./src/modules/share/share.controller");

async function finalVerify() {
    try {
        // 1. Find User
        const userRes = await pool.query("SELECT user_id FROM users LIMIT 1;");
        const userId = userRes.rows[0].user_id;

        // 2. Find Job
        const jobRes = await pool.query("SELECT job_id FROM jobs WHERE is_active = TRUE AND status = 'ACTIVE' LIMIT 1;");
        const jobId = jobRes.rows[0].job_id;

        // 3. Mock Req/Res
        const req = {
            user: { sub: userId },
            body: { jobId },
            headers: {}
        };

        let responseStatus = null;
        let responseBody = null;
        const res = {
            status: function(s) { responseStatus = s; return this; },
            json: function(j) { responseBody = j; return this; }
        };

        await shareController.shareJobToStory(req, res);

        console.log("Status:", responseStatus);

        if ((responseStatus === 200 || responseStatus === 201) && responseBody.story) {
            const dbRes = await pool.query("SELECT story_metadata FROM stories WHERE story_id = $1", [responseBody.story.story_id]);
            const metadata = dbRes.rows[0].story_metadata;
            
            if (metadata.type === 'job' && metadata.job_id === jobId) {
                console.log("⭐ VERIFICATION COMPLETE: Feature works perfectly.");
                console.log("Metadata:", JSON.stringify(metadata));
            } else {
                console.log("❌ Metadata mismatch.");
            }
        } else {
            console.log("❌ Failed:", responseStatus, JSON.stringify(responseBody));
        }

    } catch (err) {
        console.error("error:", err);
    } finally {
        process.exit();
    }
}

finalVerify();
