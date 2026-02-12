
require('dotenv').config({ path: ['.env.local', '.env'] }); // TOP PRIORITY

// console.log("DB URL:", process.env.DATABASE_URL ? "Defined" : "Undefined");
const pool = require('../src/db/pool');

async function runTest() {
    console.log("🚀 Starting Company Post Interaction Verification...");
    const client = await pool.connect();

    try {
        console.log("1️⃣ Setting up test data...");
        await client.query("BEGIN");

        // 1. Create Users
        const userA = await client.query(`INSERT INTO users (full_name, email, password_hash) VALUES ('User A (Admin)', 'usera_' || NOW()::text || '@test.com', 'hash') RETURNING user_id`);
        const userIdA = userA.rows[0].user_id;

        const userB = await client.query(`INSERT INTO users (full_name, email, password_hash) VALUES ('User B (Public)', 'userb_' || NOW()::text || '@test.com', 'hash') RETURNING user_id`);
        const userIdB = userB.rows[0].user_id;

        // 2. Create Company C (owned by A)
        const company = await client.query(`INSERT INTO companies (name, email, industry, slug) VALUES ('Company C', 'comp_' || NOW()::text || '@test.com', 'Tech', 'company-c-' || (RANDOM() * 1000)::int) RETURNING company_id`);
        const companyId = company.rows[0].company_id;

        await client.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'ADMIN')`, [companyId, userIdA]);

        // 3. Company C creates a Post
        const compPost = await client.query(`INSERT INTO posts (author_id, content, visibility, author_company_id, post_type) VALUES ($1, 'Company Post', 'public', $2, 'article') RETURNING post_id`, [userIdA, companyId]);
        const compPostId = compPost.rows[0].post_id;

        // 4. User B creates a Post
        const userBPost = await client.query(`INSERT INTO posts (author_id, content, visibility, post_type) VALUES ($1, 'User B Post', 'public', 'article') RETURNING post_id`, [userIdB]);
        const userBPostId = userBPost.rows[0].post_id;

        await client.query("COMMIT");

        // --- scenario 1: User B likes Company Post ---
        console.log("2️⃣ Testing User B Like -> Company Post...");
        // Call toggleLike (Simulate API call via logic)
        // We can't easily call controller directly without req/res mock, so we insert/simulate logic or mock it. 
        // Better to CALL the controller function if possible, but requires req/res.
        // Let's assume we invoke the logic by inserting into DB and checking notification ? No, logic IS in the controller.
        // We must mock req/res.

        const contentController = require('../src/controllers/content.controller');

        const mockRes = () => {
            const res = {};
            res.status = (code) => { res.statusCode = code; return res; };
            res.json = (data) => { res.body = data; return res; };
            return res;
        };

        // User B likes Company Post
        let req1 = {
            user: { sub: userIdB },
            params: { id: compPostId },
            body: {} // Toggle like
        };
        await contentController.toggleLike(req1, mockRes());

        // CHECK NOTIFICATION FOR COMPANY
        const notif1 = await client.query(`SELECT * FROM notifications WHERE recipient_company_id = $1 AND type = 'like' AND reference_id = $2`, [companyId, compPostId]);
        if (notif1.rowCount > 0 && notif1.rows[0].sender_id === userIdB) {
            console.log("   ✅ PASSED: Company C received like notification from User B.");
        } else {
            console.error("   ❌ FAILED: Notification not found or incorrect.");
            const debug1 = await client.query(`SELECT * FROM notifications WHERE reference_id = $1`, [compPostId]);
            console.log("   Debug: ", debug1.rows);
        }

        // --- scenario 2: User A (Admin) likes Company Post ---
        console.log("3️⃣ Testing User A (Admin) Like -> Company Post (Should NOT be self-like)...");
        let req2 = {
            user: { sub: userIdA },
            params: { id: compPostId },
            body: {}
        };
        await contentController.toggleLike(req2, mockRes());

        const notif2 = await client.query(`SELECT * FROM notifications WHERE recipient_company_id = $1 AND type = 'like' AND sender_id = $2`, [companyId, userIdA]);
        if (notif2.rowCount > 0) {
            console.log("   ✅ PASSED: Company C received like notification from Admin User A.");
        } else {
            console.error("   ❌ FAILED: Notification suppressed as self-like?");
        }


        // --- scenario 3: User B Reposts Company Post ---
        console.log("4️⃣ Testing User B Repost -> Company Post...");
        let req3 = {
            user: { sub: userIdB },
            body: {
                content: "Reposting",
                category: "General", // Need valid category
                shared_post_id: compPostId
            }
        };
        // Need a category
        const cat = await client.query(`SELECT name FROM post_categories LIMIT 1`);
        if (cat.rowCount > 0) req3.body.category = cat.rows[0].name;
        else req3.body.category = "General"; // Hope it exists or mock fails

        await contentController.createPost(req3, mockRes());

        // Check Notification for Company
        const notif3 = await client.query(`SELECT * FROM notifications WHERE recipient_company_id = $1 AND type = 'repost' AND sender_id = $2`, [companyId, userIdB]);
        if (notif3.rowCount > 0) {
            console.log("   ✅ PASSED: Company C received repost notification.");
        } else {
            console.error("   ❌ FAILED: Company did not receive repost notification.");
        }

        // --- scenario 4: Company C Reposts User B Post ---
        console.log("5️⃣ Testing Company C Repost -> User B Post...");
        let req4 = {
            user: { sub: userIdA }, // Admin acting
            body: {
                content: "Company Reposting",
                category: req3.body.category,
                shared_post_id: userBPostId,
                companyId: companyId
            }
        };
        await contentController.createPost(req4, mockRes());

        // Check Notification for User B
        // Should have metadata company_id
        const notif4 = await client.query(`SELECT * FROM notifications WHERE user_id = $1 AND type = 'repost' AND reference_id IS NOT NULL`, [userIdB]);
        // reference_id is the NEW post, so we might need to check sender/text
        // Or check metadata
        const recentNotif = notif4.rows.sort((a, b) => b.created_at - a.created_at)[0];

        if (recentNotif && recentNotif.metadata && recentNotif.metadata.company_id === companyId) {
            console.log("   ✅ PASSED: User B received repost notification from Company C.");
            console.log("   Text: " + recentNotif.text);
            if (recentNotif.text.includes("Company C")) {
                console.log("   ✅ PASSED: Notification text used Company Name.");
            } else {
                console.error("   ❌ FAILED: Notification text used User Name (" + recentNotif.text + ")");
            }
        } else {
            console.error("   ❌ FAILED: User B did not receive correct notification.");
            console.log("   recentNotif:", recentNotif);
        }

    } catch (err) {
        console.error("❌ Test Failed:", err);
    } finally {
        // Cleanup? 
        // We leave data for debugging if needed, or rely on test DB isolation (not present here).
        // It's a dev env, so maybe cleanup.
        // await client.query("DELETE FROM users WHERE ...") // Too risky.
        await client.release();
        await pool.end();
    }
}

runTest();
