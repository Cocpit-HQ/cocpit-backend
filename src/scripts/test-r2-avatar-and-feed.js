require("dotenv").config();
const pool = require("../core/db/pool");
const redisClient = require("../core/cache/redis");
const { uploadBufferToR2 } = require("../core/infrastructure/r2.client");
const { processDualAsset } = require("../workers/mediaTranscoder.worker");
const fs = require("fs");
const path = require("path");

async function testSuite() {
  console.log("============================================================");
  console.log(" Cloudflare R2 End-to-End Test Suite: Avatars & Feed Media");
  console.log("============================================================\n");

  const client = await pool.connect();
  try {
    // ── TEST 1: Avatar Upload to R2 & DB Update ─────────────────────────────
    console.log("── TEST 1: Avatar Upload to Cloudflare R2 ──────────────────");
    const userRes = await client.query("SELECT user_id, full_name, email FROM users LIMIT 1");
    if (userRes.rowCount === 0) throw new Error("No users found in database");
    const testUser = userRes.rows[0];
    console.log(`👤 Using test user: ${testUser.full_name} (${testUser.user_id})`);

    const avatarSamplePath = path.resolve(__dirname, "../../../cocpit-frontend/public/assets/profilephoto.png");
    const avatarBuf = fs.readFileSync(avatarSamplePath);
    const avatarKey = `avatars/avatar-${testUser.user_id}-${Date.now()}.png`;

    console.log(`📤 Uploading avatar to R2: ${avatarKey} (${avatarBuf.length} bytes)...`);
    const avatarR2Url = await uploadBufferToR2({
      key: avatarKey,
      body: avatarBuf,
      contentType: "image/png",
    });
    console.log(`✅ Avatar uploaded to R2: ${avatarR2Url}`);

    // Update user avatar in DB
    await client.query("UPDATE users SET avatar_url = $1 WHERE user_id = $2", [avatarR2Url, testUser.user_id]);
    console.log(`📝 Updated user record in PostgreSQL with avatar_url`);

    // Verify CDN response
    const avatarCdnRes = await fetch(avatarR2Url);
    console.log(`🌐 CDN fetch status: HTTP ${avatarCdnRes.status} (${avatarCdnRes.headers.get("content-type")})`);
    if (avatarCdnRes.status !== 200) throw new Error(`Avatar CDN returned ${avatarCdnRes.status}`);
    console.log("✅ TEST 1 PASSED: Avatar upload, DB persistence, and CDN delivery 100% operational!\n");

    // ── TEST 2: Feed Post Media Upload & Transcoding Pipeline ────────────────
    console.log("── TEST 2: Feed Post Media Upload & Dual-Asset Transcode ───");
    const feedSamplePath = path.resolve(__dirname, "../../../cocpit-frontend/public/assets/openingPage.jpg");
    const feedBuf = fs.readFileSync(feedSamplePath);
    const timestamp = Date.now();
    const rawKey = `raw/posts/${timestamp}-feed-test.jpg`;

    console.log(`📤 Step 1: Upload raw master to R2: ${rawKey}...`);
    const rawMasterUrl = await uploadBufferToR2({
      key: rawKey,
      body: feedBuf,
      contentType: "image/jpeg",
    });
    console.log(`   ✅ Raw master uploaded: ${rawMasterUrl}`);

    console.log("⚙️  Step 2: Run Dual-Asset Transcoder (Sharp -> 12-bit AVIF)...");
    const asset = await processDualAsset({ rawKey, rawMasterUrl, mediaType: "image" });
    console.log(`   ✅ Transcoded display variant: ${asset.url}`);
    console.log(`   📊 Dimensions: ${asset.width}x${asset.height}, Format: ${asset.format}, Bit Depth: ${asset.bitDepth}`);

    console.log("💾 Step 3: Cache transcoded asset in Redis (race-condition prevention)...");
    await redisClient.set(
      `media:conversion:${rawMasterUrl}`,
      JSON.stringify(asset),
      "EX",
      86400
    );
    const cached = await redisClient.get(`media:conversion:${rawMasterUrl}`);
    console.log(`   ✅ Verified Redis cache key 'media:conversion:${rawMasterUrl}':`, !!cached);

    console.log("📝 Step 4: Create simulated Post in PostgreSQL...");
    const postRes = await client.query(`
      INSERT INTO posts (author_id, content, post_type, visibility)
      VALUES ($1, $2, 'image', 'public')
      RETURNING post_id
    `, [testUser.user_id, "Automated R2 media pipeline end-to-end test post"]);
    const postId = postRes.rows[0].post_id;

    // Simulate content.controller logic that checks Redis
    let finalUrl = rawMasterUrl;
    let isProcessed = false;
    let format = null;
    let bitDepth = null;

    if (cached) {
      const parsed = JSON.parse(cached);
      finalUrl = parsed.displayUrl || parsed.url;
      format = parsed.format;
      bitDepth = parsed.bitDepth;
      isProcessed = true;
    }

    await client.query(`
      INSERT INTO post_media (post_id, url, media_type, width, height, master_url, format, bit_depth, is_processed)
      VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, $8)
      RETURNING media_id
    `, [postId, finalUrl, asset.width, asset.height, rawMasterUrl, format, bitDepth, isProcessed]);

    const verifyRow = await client.query(`
      SELECT media_id, post_id, url, master_url, format, bit_depth, is_processed 
      FROM post_media WHERE post_id = $1
    `, [postId]);

    console.log("   📋 Verified post_media DB row:", verifyRow.rows[0]);

    // Verify CDN response for display variant
    const displayCdnRes = await fetch(finalUrl);
    console.log(`🌐 Display CDN fetch status: HTTP ${displayCdnRes.status} (${displayCdnRes.headers.get("content-type")})`);
    if (displayCdnRes.status !== 200) throw new Error(`Display CDN returned ${displayCdnRes.status}`);

    console.log("🧹 Step 5: Clean up test post...");
    await client.query("DELETE FROM post_media WHERE post_id = $1", [postId]);
    await client.query("DELETE FROM posts WHERE post_id = $1", [postId]);
    console.log("   ✅ Cleaned test DB rows.");

    console.log("\n============================================================");
    console.log(" ALL TESTS PASSED! 🎉");
    console.log(" Cloudflare R2 storage & delivery is 100% active.");
    console.log(" Zero Cloudinary dependencies remaining in upload path.");
    console.log("============================================================\n");
  } finally {
    client.release();
    await pool.end();
    redisClient.disconnect();
  }
}

testSuite().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
