require('dotenv').config();
const pool = require("./src/core/db/pool");
const shareController = require("./src/modules/share/share.controller");

async function verify() {
    const jobId = "407f2670-7247-4bed-959d-1519c88e959c";
    const userId = "6761c039-1c93-4aa8-bf92-9286d7a384c4";

    const req = {
        user: { sub: userId },
        body: { jobId },
        headers: {}
    };

    let responseBody = null;
    let responseStatus = null;

    const res = {
        status: function(s) { 
            responseStatus = s; 
            return this; 
        },
        json: function(j) { 
            responseBody = j;
            return this;
        }
    };

    console.log("Calling shareJobToStory...");
    try {
        await shareController.shareJobToStory(req, res);

        console.log("Response Status:", responseStatus);
        console.log("Response Body:", JSON.stringify(responseBody));
        
        if (responseStatus !== 200) {
            console.log("❌ Error during shareJobToStory execution.");
            return;
        }

        if (responseBody.story && responseBody.story.story_id) {
            const storyId = responseBody.story.story_id;
            console.log("Checking DB for storyId:", storyId);

            const storiesRes = await pool.query(
                "SELECT * FROM stories WHERE story_id = $1",
                [storyId]
            );

            if (storiesRes.rowCount > 0) {
                const story = storiesRes.rows[0];
                console.log("✅ Story Found in DB.");
                console.log("Metadata:", JSON.stringify(story.story_metadata));
                
                if (story.story_metadata.type === 'job' && story.story_metadata.job_id === jobId) {
                    console.log("✅ Verification Success: Metadata is correct.");
                    console.log("Job Title in Metadata:", story.story_metadata.title);
                } else {
                    console.log("❌ Verification Failed: Metadata mismatch.");
                }
            } else {
                console.log("❌ Verification Failed: Story returned but not in DB.");
            }
        }
    } catch (err) {
        console.error("Verification Error:", err);
    } finally {
        process.exit();
    }
}

verify();
