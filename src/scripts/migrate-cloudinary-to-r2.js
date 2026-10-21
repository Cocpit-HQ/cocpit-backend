require("dotenv").config();
const pool = require("../core/db/pool");
const { uploadBufferToR2, objectExistsInR2, getPublicUrl } = require("../core/infrastructure/r2.client");

/**
 * Migration Script: Transfer legacy Cloudinary assets to Cloudflare R2 (cocpit-db).
 *
 * Usage:
 *   node src/scripts/migrate-cloudinary-to-r2.js --dry-run
 *   node src/scripts/migrate-cloudinary-to-r2.js --limit=5
 *   node src/scripts/migrate-cloudinary-to-r2.js --cloud=owfezxtx
 *   node src/scripts/migrate-cloudinary-to-r2.js
 */

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const cloudArg = process.argv.find((a) => a.startsWith("--cloud="));
const TARGET_CLOUD = cloudArg ? cloudArg.split("=")[1] : (process.env.CLOUDINARY_CLOUD_NAME || "owfezxtx");
const CONCURRENCY = 5;

function deriveR2LegacyKey(cloudinaryUrl) {
  try {
    const parsed = new URL(cloudinaryUrl);
    // Path looks like /owfezxtx/image/upload/v1790834698/posts/1790834686727-pic.webp.webp
    const segments = parsed.pathname.split("/").filter(Boolean);
    const filename = segments[segments.length - 1] || `legacy-${Date.now()}`;
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `legacy/posts/${sanitizedFilename}`;
  } catch {
    const timestamp = Date.now();
    return `legacy/posts/${timestamp}-asset`;
  }
}

async function fetchBufferWithRetry(url, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      const arrayBuffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      return { buffer: Buffer.from(arrayBuffer), contentType };
    } catch (err) {
      if (err.status === 401 || err.status === 404 || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function runMigration() {
  console.log("============================================================");
  console.log(" Cloudflare R2 Legacy Asset Migration Engine");
  console.log(` Target Bucket       : ${process.env.R2_BUCKET_NAME || 'cocpit-db'}`);
  console.log(` Target Cloudinary   : ${TARGET_CLOUD || 'ALL'}`);
  console.log(` Mode                : ${DRY_RUN ? "DRY-RUN (No changes applied)" : "LIVE EXECUTION"}`);
  if (LIMIT) console.log(` Limit               : ${LIMIT} items`);
  console.log("============================================================\n");

  const client = await pool.connect();
  try {
    let whereClause = `WHERE url LIKE '%res.cloudinary.com%'`;
    const params = [];

    if (TARGET_CLOUD && TARGET_CLOUD !== "ALL") {
      params.push(`%res.cloudinary.com/${TARGET_CLOUD}/%`);
      whereClause += ` AND url LIKE $${params.length}`;
    }

    const query = `
      SELECT media_id, post_id, url, media_type 
      FROM post_media 
      ${whereClause}
      ORDER BY post_id DESC
      ${LIMIT ? `LIMIT ${LIMIT}` : ""}
    `;
    const res = await client.query(query, params);
    const totalFound = res.rowCount;

    console.log(`[Migration] Found ${totalFound} assets matching Cloudinary cloud '${TARGET_CLOUD}'.\n`);

    if (totalFound === 0) {
      console.log("[Migration] No media matching filter. Done!");
      return;
    }

    if (DRY_RUN) {
      console.log("[Migration] Sample candidate items for migration:");
      res.rows.slice(0, 5).forEach((r, i) => {
        const targetKey = deriveR2LegacyKey(r.url);
        console.log(`  ${i + 1}. [${r.media_id}] ${r.url}`);
        console.log(`     ↳ Target R2 Key: ${targetKey}`);
        console.log(`     ↳ Target CDN URL: ${getPublicUrl(targetKey)}\n`);
      });
      console.log(`[DryRun Complete] ${totalFound} items would be processed in live run.`);
      return;
    }

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in batches with concurrency
    for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
      const batch = res.rows.slice(i, i + CONCURRENCY);

      await Promise.all(
        batch.map(async (row) => {
          const { media_id, url: sourceUrl } = row;
          const targetKey = deriveR2LegacyKey(sourceUrl);

          try {
            // Check if already uploaded to R2
            const alreadyExists = await objectExistsInR2(targetKey);
            let r2Url;

            if (alreadyExists) {
              r2Url = getPublicUrl(targetKey);
              skippedCount++;
              console.log(`[Migration] ⏩ Already exists in R2: ${targetKey}`);
            } else {
              console.log(`[Migration] ⬇️ Fetching: ${sourceUrl}`);
              const { buffer, contentType } = await fetchBufferWithRetry(sourceUrl);

              console.log(`[Migration] ⬆️ Uploading to R2: ${targetKey} (${buffer.length} bytes, ${contentType})`);
              r2Url = await uploadBufferToR2({
                key: targetKey,
                body: buffer,
                contentType,
                cacheControl: "public, max-age=31536000, immutable",
              });
              successCount++;
            }

            // Update database row
            await client.query(
              `UPDATE post_media 
               SET url = $1, master_url = $2, is_processed = TRUE 
               WHERE media_id = $3`,
              [r2Url, r2Url, media_id]
            );

            console.log(`[Migration] ✅ DB row ${media_id} updated → ${r2Url}`);
          } catch (err) {
            failedCount++;
            console.error(`[Migration] ❌ Skipped/Failed media ${media_id}:`, err.message);
          }
        })
      );

      console.log(`Progress: ${Math.min(i + CONCURRENCY, res.rows.length)} / ${res.rows.length} processed.`);
    }

    console.log("\n============================================================");
    console.log(" Migration Summary");
    console.log(` • Transferred to R2 : ${successCount}`);
    console.log(` • Already in R2     : ${skippedCount}`);
    console.log(` • Failed / Inaccessible : ${failedCount}`);
    console.log("============================================================");
  } finally {
    client.release();
    process.exit(0);
  }
}

runMigration().catch((err) => {
  console.error("Migration Fatal Error:", err);
  process.exit(1);
});
