const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const http = require('http');
const app = require('../src/app');
const axios = require('axios');
const pool = require('../src/db/pool');

const PORT = 5003;
const API_URL = `http://localhost:${PORT}/api`;

let server;
let ownerToken, ownerId;
let otherToken, otherId;
let companyId;
let postId;
let commentId;

const companySlug = 'interactions-corp-' + Date.now();

async function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(PORT, () => {
            console.log(`Test server running on port ${PORT}`);
            resolve();
        });
    });
}

async function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

async function registerUser(email, name) {
    try {
        await axios.post(`${API_URL}/auth/register`, {
            email,
            password: 'password123',
            fullName: name,
            mobileNumber: '1234567890',
            accountType: 'Employer' // or candidate
        });
        const loginRes = await axios.post(`${API_URL}/auth/login`, { email, password: 'password123' });
        return { token: loginRes.data.accessToken, id: loginRes.data.user.id };
    } catch (err) {
        console.log(`Register failed for ${email}, trying login...`);
        const loginRes = await axios.post(`${API_URL}/auth/login`, { email, password: 'password123' });
        return { token: loginRes.data.accessToken, id: loginRes.data.user.id };
    }
}

async function runTests() {
    try {
        await startServer();

        console.log("\n1. Setup Users...");
        const owner = await registerUser(`boss_${Date.now()}@test.com`, 'Boss User');
        ownerToken = owner.token;
        ownerId = owner.id;
        console.log(`   Owner ID: ${ownerId}`);

        const other = await registerUser(`other_${Date.now()}@test.com`, 'Other User');
        otherToken = other.token;
        otherId = other.id;
        console.log(`   Other ID: ${otherId}`);

        console.log("\n2. Create Company...");
        const createRes = await axios.post(`${API_URL}/companies`, {
            name: "Interactions Corp",
            slug: companySlug,
            email: `contact_${Date.now()}@inter.com`,
            industry: "Tech",
            size: "1-10",
            location: "Remote"
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });
        companyId = createRes.data.company.company_id;
        console.log(`   Created Company ID: ${companyId}`);

        console.log("\n2.5. Get Category...");
        let categoryName = 'Professional';
        const catRes = await pool.query("SELECT name FROM post_categories LIMIT 1");
        if (catRes.rowCount > 0) {
            categoryName = catRes.rows[0].name;
        } else {
            await pool.query("INSERT INTO post_categories (name) VALUES ($1)", [categoryName]);
        }
        console.log(`   Using Category: ${categoryName}`);

        console.log("\n3. Other User Creates Post...");
        const postRes = await axios.post(`${API_URL}/post`, {
            content: "Hello World! This is a test post.",
            visibility: "public",
            category: categoryName
        }, {
            headers: { Authorization: `Bearer ${otherToken}` }
        });
        postId = postRes.data.postId || postRes.data.post_id;
        if (!postId && postRes.data.post) postId = postRes.data.post.post_id;
        console.log(`   Created Post ID: ${postId}`);

        console.log("\n4. Company Comments on Post...");
        const commentRes = await axios.post(`${API_URL}/post/${postId}/comments`, {
            content: "Great post! - via Corp",
            companyId: companyId
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });

        const comment = commentRes.data.comment;
        commentId = comment.comment_id;
        console.log(`   Comment Created ID: ${commentId}`);

        // VERIFY DB
        const dbComment = await pool.query("SELECT author_company_id FROM post_comments WHERE comment_id = $1", [commentId]);
        if (dbComment.rows[0].author_company_id !== companyId) {
            throw new Error(`DB Attribution Failed! Expected ${companyId}, got ${dbComment.rows[0].author_company_id}`);
        }
        console.log("   ✅ Comment correctly attributed to Company in DB");

        console.log("\n5. Company Likes Post...");
        const likeRes = await axios.post(`${API_URL}/post/${postId}/like`, {
            companyId: companyId
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });

        if (!likeRes.data.liked) throw new Error("Like should be true");

        // VERIFY DB
        const dbLike = await pool.query("SELECT company_id FROM post_likes WHERE post_id = $1 AND company_id = $2", [postId, companyId]);
        if (dbLike.rowCount === 0) throw new Error("Post Like not found in DB or not attributed to company");
        console.log("   ✅ Post Like correctly attributed to Company in DB");

        console.log("\n6. Company Likes Comment...");
        // Have other user comment first, or just like the company's own comment (which is allowed)
        // Let's like the company's own comment
        const commentLikeRes = await axios.post(`${API_URL}/comments/${commentId}/like`, {
            companyId: companyId
        }, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });

        if (!commentLikeRes.data.liked) throw new Error("Comment Like should be true");

        // VERIFY DB
        const dbCommentLike = await pool.query("SELECT company_id FROM comment_likes WHERE comment_id = $1 AND company_id = $2", [commentId, companyId]);
        if (dbCommentLike.rowCount === 0) throw new Error("Comment Like not found in DB or not attributed to company");
        console.log("   ✅ Comment Like correctly attributed to Company in DB");

        // 7. Verify GET Comments API Endpoint
        console.log('\n--- 7. Verify GET Comments API ---');
        const getUrl = `${API_URL}/post/${postId}/comments?companyId=${companyId}`;
        const getRes = await axios.get(getUrl, {
            headers: { Authorization: `Bearer ${ownerToken}` }
        });

        const apiComment = getRes.data.find(c => c.comment_id === commentId);
        if (!apiComment) throw new Error("Comment not found in API response");

        console.log(`   API Comment Author: ${apiComment.full_name}, Liked: ${apiComment.is_liked}`);

        if (apiComment.full_name !== 'Interactions Corp') {
            throw new Error(`API: Expected author 'Interactions Corp', got '${apiComment.full_name}'`);
        }
        if (!apiComment.is_liked) {
            throw new Error(`API: Expected is_liked to be true for company`);
        }
        console.log('   ✅ GET Comments API returns correct Company details and like status');

        // 8. Verify GET Comments API Logic (SQL Check) - KEEPING FOR DOUBLE CHECK
        console.log('\n--- 8. Verify GET Comments SQL Logic ---');
        const getCommentsQuery = `
      SELECT 
        c.comment_id,
        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.name 
            ELSE u.full_name 
        END AS full_name,
        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.logo_url 
            ELSE u.avatar_url 
        END AS avatar_url,
        c.author_company_id
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      LEFT JOIN companies comp ON c.author_company_id = comp.company_id
      WHERE c.post_id = $1
      `;

        const commentsRes = await pool.query(getCommentsQuery, [postId]);
        const fetchedComment = commentsRes.rows.find(c => c.comment_id === commentId);

        if (!fetchedComment) throw new Error('Comment not found in query result');

        console.log(`   Fetched Comment Author: ${fetchedComment.full_name}`);
        // console.log(`   Fetched Comment Avatar: ${fetchedComment.avatar_url}`);

        if (fetchedComment.full_name !== 'Interactions Corp') {
            throw new Error(`Expected author 'Interactions Corp', got '${fetchedComment.full_name}'`);
        }
        if (fetchedComment.author_company_id !== companyId) {
            throw new Error(`Expected author_company_id '${companyId}', got '${fetchedComment.author_company_id}'`);
        }

        console.log('   ✅ GET Comments SQL returns correct Company details');

        console.log("\n✅ ALL VERIFICATIONS PASSED");

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error("❌ Test Failed:", errorMsg);
        require('fs').writeFileSync('error.log', `Error: ${errorMsg}\nStack: ${err.stack}`);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    } finally {
        await stopServer();
        // Just in case
        await pool.end();
        process.exit(0);
    }
}

runTests();
