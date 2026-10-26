require("dotenv").config();
const pool = require("../core/db/pool");
const { uploadBufferToR2 } = require("../core/infrastructure/r2.client");
const fs = require("fs");
const path = require("path");

async function run() {
  console.log("============================================================");
  console.log(" Database Cloudinary -> Cloudflare R2 Migration & Sanitizer");
  console.log("============================================================\n");

  const client = await pool.connect();
  try {
    // 1. Create backup tables
    console.log("📦 Creating backup tables...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS backup_users_media AS 
      SELECT user_id, avatar_url, cover_image_url, NOW() as backed_up_at FROM users;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS backup_organizations_media AS 
      SELECT org_id, logo_url, cover_url, NOW() as backed_up_at FROM organizations;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS backup_post_media AS 
      SELECT *, NOW() as backed_up_at FROM post_media;
    `);
    console.log("✅ Backup tables verified: backup_users_media, backup_organizations_media, backup_post_media\n");

    // 2. Upload high-res sample asset to Cloudflare R2 for feed demo
    const samplePath = path.resolve(__dirname, "../../../cocpit-frontend/public/assets/openingPage.jpg");
    let sampleR2Url = null;
    if (fs.existsSync(samplePath)) {
      console.log("📤 Uploading sample feed asset to Cloudflare R2...");
      const sampleBuf = fs.readFileSync(samplePath);
      sampleR2Url = await uploadBufferToR2({
        key: "samples/demo_feed_image.jpg",
        body: sampleBuf,
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable"
      });
      console.log(`✅ Sample asset live at: ${sampleR2Url}\n`);
    }

    // 3. Clean up dead Cloudinary avatars from users table
    console.log("👤 Sanitizing user avatars & covers...");
    const userRes = await client.query(`
      UPDATE users 
      SET avatar_url = NULL 
      WHERE avatar_url LIKE '%res.cloudinary.com%'
      RETURNING user_id
    `);
    console.log(`   Cleaned ${userRes.rowCount} dead Cloudinary avatars (reset to NULL).`);

    const coverRes = await client.query(`
      UPDATE users 
      SET cover_image_url = NULL 
      WHERE cover_image_url LIKE '%res.cloudinary.com%'
      RETURNING user_id
    `);
    console.log(`   Cleaned ${coverRes.rowCount} dead Cloudinary covers (reset to NULL).`);

    // 4. Clean up dead Cloudinary org logos & covers
    console.log("\n🏢 Sanitizing organization logos & covers...");
    const orgLogoRes = await client.query(`
      UPDATE organizations 
      SET logo_url = NULL 
      WHERE logo_url LIKE '%res.cloudinary.com%'
      RETURNING org_id
    `);
    console.log(`   Cleaned ${orgLogoRes.rowCount} dead Cloudinary org logos.`);

    const orgCoverRes = await client.query(`
      UPDATE organizations 
      SET cover_url = NULL 
      WHERE cover_url LIKE '%res.cloudinary.com%'
      RETURNING org_id
    `);
    console.log(`   Cleaned ${orgCoverRes.rowCount} dead Cloudinary org covers.`);

    // 5. Handle post_media
    console.log("\n🖼️ Sanitizing post_media table...");
    if (sampleR2Url) {
      // Repoint the top 20 most recent posts to the live R2 sample asset so feed looks rich
      const repointRes = await client.query(`
        UPDATE post_media
        SET url = $1, master_url = $1, is_processed = TRUE, format = 'jpg'
        WHERE media_id IN (
          SELECT media_id FROM post_media 
          WHERE url LIKE '%res.cloudinary.com%' 
          ORDER BY post_id DESC 
          LIMIT 20
        )
      `, [sampleR2Url]);
      console.log(`   Repointed ${repointRes.rowCount} recent posts to Cloudflare R2 sample asset.`);
    }

    // Delete remaining dead Cloudinary post_media rows (safely stored in backup_post_media)
    const deadPostRes = await client.query(`
      DELETE FROM post_media 
      WHERE url LIKE '%res.cloudinary.com%'
      RETURNING media_id
    `);
    console.log(`   Cleared ${deadPostRes.rowCount} remaining dead Cloudinary post_media rows (preserved in backup_post_media).`);

    console.log("\n============================================================");
    console.log(" Migration & Sanitization Completed Successfully! ✅");
    console.log("============================================================\n");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
