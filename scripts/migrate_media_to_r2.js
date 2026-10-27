/**
 * Automated Migration Script: Cloudinary -> Cloudflare R2
 * Steps 1 & 2:
 * 1. Discover all Cloudinary URLs from target database.
 * 2. Download from Cloudinary and upload to Cloudflare R2 (cocpit-db).
 * 3. Update all table references and JSONB columns in PostgreSQL.
 */

const { Pool } = require('pg');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:sSWdEpqkZHkmXYEQUELDCXzXlooxyBAC@caboose.proxy.rlwy.net:26518/railway";

const R2_CONFIG = {
  endpoint: process.env.R2_ENDPOINT || "https://dfb9645beb803038c3b1e89183cdc126.r2.cloudflarestorage.com",
  accessKeyId: process.env.R2_ACCESS_KEY_ID || "a3737b4bbfaefed810df95e8ed81b3df",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "8cccf8ccb70c0b1697a751a427ccca80caaf698253a7d447fee56467222eaac6",
  bucket: process.env.R2_BUCKET_NAME || "cocpit-db",
  publicCdn: (process.env.R2_PUBLIC_URL || process.env.R2_CDN_BASE_URL || "https://pub-9ab7b27b805e4ef3954360339e67917a.r2.dev").replace(/\/$/, "")
};

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

const s3Client = new S3Client({
  region: "auto",
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey
  },
  forcePathStyle: true
});

function getMimeType(url, fallbackType = "application/octet-stream") {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".avif")) return "image/avif";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".pdf")) return "application/pdf";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".doc")) return "application/msword";
  if (clean.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return fallbackType;
}

function deriveR2Key(url) {
  // Check if achievement images
  if (url.includes("/achievement_images/")) {
    const filename = url.split("/achievement_images/")[1].split("?")[0];
    return `achievement_images/${filename}`;
  }

  // Cloudinary standard upload pattern: .../upload/(v\d+/)?<folder>/<filename>
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  if (match && match[1]) {
    return match[1].split("?")[0];
  }

  // Fallback: extract path from domain onwards
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

async function checkExistsInR2(key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: R2_CONFIG.bucket,
      Key: key
    }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    return false;
  }
}

async function uploadBufferToR2(key, buffer, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function discoverAllCloudinaryUrls() {
  console.log("\n[Step 1A] Querying all Cloudinary URLs from target database...");

  const queries = [
    { label: "post_media.url", sql: "SELECT DISTINCT url as u FROM post_media WHERE url ILIKE '%cloudinary%'" },
    { label: "user_resumes.file_url", sql: "SELECT DISTINCT file_url as u FROM user_resumes WHERE file_url ILIKE '%cloudinary%'" },
    { label: "users.avatar_url", sql: "SELECT DISTINCT avatar_url as u FROM users WHERE avatar_url ILIKE '%cloudinary%'" },
    { label: "users.cover_image_url", sql: "SELECT DISTINCT cover_image_url as u FROM users WHERE cover_image_url ILIKE '%cloudinary%'" },
    { label: "project_media.url", sql: "SELECT DISTINCT url as u FROM project_media WHERE url ILIKE '%cloudinary%'" },
    { label: "project_media.file_url", sql: "SELECT DISTINCT file_url as u FROM project_media WHERE file_url ILIKE '%cloudinary%'" },
    { label: "organizations.logo_url", sql: "SELECT DISTINCT logo_url as u FROM organizations WHERE logo_url ILIKE '%cloudinary%'" },
    { label: "organizations.cover_url", sql: "SELECT DISTINCT cover_url as u FROM organizations WHERE cover_url ILIKE '%cloudinary%'" },
    { label: "achievement_images.cloudinary_url", sql: "SELECT DISTINCT cloudinary_url as u FROM achievement_images WHERE cloudinary_url ILIKE '%cloudinary%'" },
    { label: "user_verifications.front_image_url", sql: "SELECT DISTINCT front_image_url as u FROM user_verifications WHERE front_image_url ILIKE '%cloudinary%'" },
    { label: "user_verifications.back_image_url", sql: "SELECT DISTINCT back_image_url as u FROM user_verifications WHERE back_image_url ILIKE '%cloudinary%'" },
    { label: "support_tickets.attachment_url", sql: "SELECT DISTINCT attachment_url as u FROM support_tickets WHERE attachment_url ILIKE '%cloudinary%'" },
    { label: "organization_documents.document_url", sql: "SELECT DISTINCT document_url as u FROM organization_documents WHERE document_url ILIKE '%cloudinary%'" }
  ];

  const urlSet = new Set();

  for (const q of queries) {
    const res = await pool.query(q.sql);
    res.rows.forEach(r => {
      if (r.u && typeof r.u === 'string' && r.u.includes('cloudinary')) {
        urlSet.add(r.u.trim());
      }
    });
  }

  // Extract from JSONB and text columns
  const orgVerif = await pool.query("SELECT document_urls FROM organization_verifications WHERE document_urls::text ILIKE '%cloudinary%'");
  orgVerif.rows.forEach(r => {
    if (Array.isArray(r.document_urls)) {
      r.document_urls.forEach(u => {
        if (typeof u === 'string' && u.includes('cloudinary')) urlSet.add(u.trim());
      });
    }
  });

  const postsContent = await pool.query("SELECT content FROM posts WHERE content ILIKE '%cloudinary%'");
  postsContent.rows.forEach(r => {
    const matches = r.content.match(/https?:\/\/res\.cloudinary\.com[^\s"'<>]+/g) || [];
    matches.forEach(u => urlSet.add(u.trim()));
  });

  const userSearch = await pool.query("SELECT profile_snapshot FROM user_search_history WHERE profile_snapshot::text ILIKE '%cloudinary%'");
  userSearch.rows.forEach(r => {
    const matches = JSON.stringify(r.profile_snapshot).match(/https?:\\\/\\\/res\.cloudinary\.com[^\s"'<>]+/g) || [];
    matches.forEach(u => {
      const cleanUrl = u.replace(/\\\//g, '/');
      urlSet.add(cleanUrl.trim());
    });
  });

  const auditLogs = await pool.query("SELECT metadata FROM audit_logs WHERE metadata::text ILIKE '%cloudinary%'");
  auditLogs.rows.forEach(r => {
    const matches = JSON.stringify(r.metadata).match(/https?:\\\/\\\/res\.cloudinary\.com[^\s"'<>]+/g) || [];
    matches.forEach(u => {
      const cleanUrl = u.replace(/\\\//g, '/');
      urlSet.add(cleanUrl.trim());
    });
  });

  console.log(`[Step 1A] Total unique Cloudinary URLs discovered: ${urlSet.size}`);
  return Array.from(urlSet);
}

async function runStep1(urls) {
  console.log("\n[Step 1B] Downloading from Cloudinary and uploading to Cloudflare R2...");
  const mapping = {};
  const failed = [];
  const skipped = [];
  let successCount = 0;

  // Process in batches of 5 concurrent operations to maintain speed while avoiding socket exhaustion
  const BATCH_SIZE = 5;

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (url) => {
      const r2Key = deriveR2Key(url);
      const r2Url = `${R2_CONFIG.publicCdn}/${r2Key}`;

      // Check if already in R2
      const exists = await checkExistsInR2(r2Key);
      if (exists) {
        mapping[url] = r2Url;
        skipped.push({ url, r2Key, reason: "Already exists in R2" });
        return;
      }

      // Download from Cloudinary
      try {
        const resp = await fetchWithRetry(url);
        if (!resp.ok) {
          failed.push({ url, status: resp.status, statusText: resp.statusText });
          return;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const headerType = resp.headers.get("content-type");
        const contentType = getMimeType(url, headerType || "application/octet-stream");

        await uploadBufferToR2(r2Key, buffer, contentType);
        mapping[url] = r2Url;
        successCount++;
      } catch (err) {
        failed.push({ url, error: err.message });
      }
    }));

    const progress = Math.min(i + BATCH_SIZE, urls.length);
    process.stdout.write(`\rProgress: ${progress} / ${urls.length} processed (${successCount} uploaded, ${skipped.length} existing, ${failed.length} failed)`);
  }

  console.log("\n\n=== STEP 1 SUMMARY ===");
  console.log(`Total URLs: ${urls.length}`);
  console.log(`Successfully Uploaded to R2: ${successCount}`);
  console.log(`Already existed in R2: ${skipped.length}`);
  console.log(`Total Mapped to R2: ${Object.keys(mapping).length}`);
  console.log(`Failed / Inaccessible (e.g. disabled accounts): ${failed.length}`);

  // Save mapping to file
  const mapPath = path.join(__dirname, 'migration_map.json');
  fs.writeFileSync(mapPath, JSON.stringify(mapping, null, 2));
  console.log(`Migration mapping saved to: ${mapPath}`);

  if (failed.length > 0) {
    const failPath = path.join(__dirname, 'migration_failed.json');
    fs.writeFileSync(failPath, JSON.stringify(failed, null, 2));
    console.log(`Failed items saved to: ${failPath}`);
  }

  return mapping;
}

async function runStep2(mapping) {
  const mapEntries = Object.entries(mapping);
  if (mapEntries.length === 0) {
    console.log("\n[Step 2] No mapped URLs to update in database.");
    return;
  }

  console.log(`\n[Step 2] Updating ${mapEntries.length} URL mappings in PostgreSQL database...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Standard column updates
    const simpleColumns = [
      { table: "post_media", col: "url" },
      { table: "user_resumes", col: "file_url" },
      { table: "users", col: "avatar_url" },
      { table: "users", col: "cover_image_url" },
      { table: "project_media", col: "url" },
      { table: "project_media", col: "file_url" },
      { table: "organizations", col: "logo_url" },
      { table: "organizations", col: "cover_url" },
      { table: "achievement_images", col: "cloudinary_url" },
      { table: "user_verifications", col: "front_image_url" },
      { table: "user_verifications", col: "back_image_url" },
      { table: "support_tickets", col: "attachment_url" },
      { table: "organization_documents", col: "document_url" }
    ];

    const stats = {};

    for (const sc of simpleColumns) {
      stats[`${sc.table}.${sc.col}`] = 0;
    }

    for (const [oldUrl, newUrl] of mapEntries) {
      for (const sc of simpleColumns) {
        const res = await client.query(
          `UPDATE ${sc.table} SET ${sc.col} = $1 WHERE ${sc.col} = $2`,
          [newUrl, oldUrl]
        );
        stats[`${sc.table}.${sc.col}`] += res.rowCount;
      }
    }

    // Special Updates: JSONB and Content
    console.log("[Step 2] Updating JSONB columns and rich-text post content...");

    let orgVerifCount = 0;
    let postContentCount = 0;
    let searchHistoryCount = 0;
    let auditLogCount = 0;

    for (const [oldUrl, newUrl] of mapEntries) {
      // organization_verifications.document_urls
      const r1 = await client.query(
        `UPDATE organization_verifications
         SET document_urls = (replace(document_urls::text, $1, $2))::jsonb
         WHERE document_urls::text ILIKE '%' || $1 || '%'`,
        [oldUrl, newUrl]
      );
      orgVerifCount += r1.rowCount;

      // posts.content
      const r2 = await client.query(
        `UPDATE posts
         SET content = replace(content, $1, $2)
         WHERE content ILIKE '%' || $1 || '%'`,
        [oldUrl, newUrl]
      );
      postContentCount += r2.rowCount;

      // user_search_history.profile_snapshot
      const r3 = await client.query(
        `UPDATE user_search_history
         SET profile_snapshot = (replace(profile_snapshot::text, $1, $2))::jsonb
         WHERE profile_snapshot::text ILIKE '%' || $1 || '%'`,
        [oldUrl, newUrl]
      );
      searchHistoryCount += r3.rowCount;

      // audit_logs.metadata
      const r4 = await client.query(
        `UPDATE audit_logs
         SET metadata = (replace(metadata::text, $1, $2))::jsonb
         WHERE metadata::text ILIKE '%' || $1 || '%'`,
        [oldUrl, newUrl]
      );
      auditLogCount += r4.rowCount;
    }

    stats['organization_verifications.document_urls'] = orgVerifCount;
    stats['posts.content'] = postContentCount;
    stats['user_search_history.profile_snapshot'] = searchHistoryCount;
    stats['audit_logs.metadata'] = auditLogCount;

    await client.query("COMMIT");
    console.log("\n=== STEP 2 DATABASE UPDATE SUMMARY ===");
    for (const [key, count] of Object.entries(stats)) {
      if (count > 0) {
        console.log(`- ${key}: ${count} rows updated`);
      }
    }

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Step 2] Error during database update, rolled back:", err);
    throw err;
  } finally {
    client.release();
  }
}

async function verifyMigration() {
  console.log("\n[Verification] Checking database for remaining Cloudinary links vs Cloudflare R2 links...");

  const r2Count = await pool.query(`
    SELECT
      (SELECT count(*) FROM post_media WHERE url ILIKE '%r2.dev%') as post_media,
      (SELECT count(*) FROM user_resumes WHERE file_url ILIKE '%r2.dev%') as user_resumes,
      (SELECT count(*) FROM users WHERE avatar_url ILIKE '%r2.dev%') as user_avatars,
      (SELECT count(*) FROM users WHERE cover_image_url ILIKE '%r2.dev%') as user_covers,
      (SELECT count(*) FROM organizations WHERE logo_url ILIKE '%r2.dev%') as org_logos,
      (SELECT count(*) FROM achievement_images WHERE cloudinary_url ILIKE '%r2.dev%') as achievements;
  `);

  console.log("\nCloudflare R2 links now active in database:");
  console.table(r2Count.rows[0]);

  const cldRemain = await pool.query(`
    SELECT
      (SELECT count(*) FROM post_media WHERE url ILIKE '%cloudinary%') as cld_post_media,
      (SELECT count(*) FROM user_resumes WHERE file_url ILIKE '%cloudinary%') as cld_user_resumes,
      (SELECT count(*) FROM users WHERE avatar_url ILIKE '%cloudinary%') as cld_user_avatars,
      (SELECT count(*) FROM achievement_images WHERE cloudinary_url ILIKE '%cloudinary%') as cld_achievements;
  `);

  console.log("\nRemaining Cloudinary links (from disabled legacy test accounts):");
  console.table(cldRemain.rows[0]);
}

async function main() {
  try {
    console.log("==================================================");
    console.log("  MEDIA MIGRATION: CLOUDINARY -> CLOUDFLARE R2    ");
    console.log("==================================================");

    const urls = await discoverAllCloudinaryUrls();
    const mapping = await runStep1(urls);
    await runStep2(mapping);
    await verifyMigration();

    console.log("\nSUCCESS: Steps 1 & 2 completed! Ready for feed/app testing before Step 3.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

main();
