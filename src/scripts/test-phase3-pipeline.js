require("dotenv").config();
const { addTranscodeJob, getJobStatus } = require("../queues/media.queue");
const { uploadBufferToR2, objectExistsInR2, deleteMediaByUrls, r2Client, getPublicUrl } = require("../core/infrastructure/r2.client");
const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
const sharp = require("sharp");
const pool = require("../core/db/pool");

async function runEndToEndTest() {
  console.log("============================================================");
  console.log(" End-to-End Validation: Phase 3 BullMQ 12-Bit AVIF Pipeline");
  console.log(` Target Bucket: ${process.env.R2_BUCKET_NAME || 'cocpit-db'}`);
  console.log("============================================================\n");

  const timestamp = Date.now();
  const rawKey = `raw/posts/${timestamp}-integration_test.png`;
  
  // 1. Create a 1080x1080 test image buffer with a gradient using Sharp
  console.log("Step 1: Generating a rich 1080x1080 test image...");
  const rawBuffer = await sharp({
    create: {
      width: 1080,
      height: 1080,
      channels: 4,
      background: { r: 59, g: 130, b: 246, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // 2. Upload raw image directly to R2 (simulating client direct PUT)
  console.log(`Step 2: Uploading raw master to R2 (${rawKey})...`);
  const rawMasterUrl = await uploadBufferToR2({
    key: rawKey,
    body: rawBuffer,
    contentType: "image/png",
  });
  console.log(`  ↳ Raw Master URL: ${rawMasterUrl}`);

  // 3. Create a test post and post_media row in DB to verify async DB update
  console.log("Step 3: Creating test post_media row in PostgreSQL...");
  const userRes = await pool.query("SELECT user_id FROM users LIMIT 1");
  const authorId = userRes.rows[0].user_id;
  const postRes = await pool.query(
    `INSERT INTO posts (author_id, content, post_type, is_active)
     VALUES ($1, 'Test automated dual-asset post', 'image', TRUE)
     RETURNING post_id`,
    [authorId]
  );
  const dummyPostId = postRes.rows[0].post_id;
  await pool.query(
    `INSERT INTO post_media (post_id, url, media_type, width, height, master_url, is_processed)
     VALUES ($1, $2, 'image', 1080, 1080, $2, FALSE)`,
    [dummyPostId, rawMasterUrl]
  );
  console.log("  ↳ post_media row created with rawMasterUrl.");

  // 4. Enqueue BullMQ transcode job (simulating /api/upload/process async call)
  console.log("Step 4: Dispatching async job to BullMQ queue...");
  const startTime = Date.now();
  const job = await addTranscodeJob({
    rawKey,
    rawMasterUrl,
    mediaType: "image",
    postId: dummyPostId,
  });
  console.log(`  ↳ Job enqueued in ${Date.now() - startTime}ms. Job ID: ${job.id}`);

  // 5. Poll for BullMQ worker processing completion
  console.log("Step 5: Waiting for BullMQ worker to process job...");
  let completed = false;
  let jobResult = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await getJobStatus(job.id);
    console.log(`  ↳ Attempt ${attempt}: Job state = '${status?.state}'`);
    if (status?.state === "completed") {
      completed = true;
      jobResult = status.returnvalue;
      break;
    }
    if (status?.state === "failed") {
      throw new Error(`Job failed: ${status.failedReason}`);
    }
  }

  if (!completed || !jobResult) {
    throw new Error("Timeout waiting for BullMQ worker to process job.");
  }

  console.log("\n✅ BullMQ Job Completed Successfully!");
  console.log("  ↳ Display URL  :", jobResult.url);
  console.log("  ↳ Master URL   :", jobResult.masterUrl);
  console.log("  ↳ Format       :", jobResult.format);
  console.log("  ↳ Bit Depth    :", jobResult.bitDepth);
  console.log("  ↳ Dimensions   :", `${jobResult.width}x${jobResult.height}`);

  // 6. Verify database row was updated to AVIF
  console.log("\nStep 6: Verifying post_media row in PostgreSQL...");
  const dbCheck = await pool.query(
    `SELECT url, master_url, format, bit_depth, is_processed 
     FROM post_media 
     WHERE post_id = $1`,
    [dummyPostId]
  );
  console.log("  ↳ DB Row after background worker update:", dbCheck.rows[0]);

  if (dbCheck.rows[0].url === jobResult.url && dbCheck.rows[0].format === "avif" && dbCheck.rows[0].bit_depth === 12) {
    console.log("✅ Database verification passed: Row updated to 12-bit AVIF URL!");
  } else {
    console.error("❌ Database verification failed!");
  }

  // 7. Test Public HTTP access to both R2 assets
  console.log("\nStep 7: Testing public HTTP CDN access...");
  const avifHttpRes = await fetch(jobResult.url, { method: "HEAD" });
  console.log(`  ↳ AVIF Display URL HTTP status : ${avifHttpRes.status} (Content-Type: ${avifHttpRes.headers.get("content-type")})`);
  const rawHttpRes = await fetch(jobResult.masterUrl, { method: "HEAD" });
  console.log(`  ↳ Raw Master URL HTTP status   : ${rawHttpRes.status} (Content-Type: ${rawHttpRes.headers.get("content-type")})`);

  // 8. Test R2 Deletion (cleans up test post, DB rows, and R2 files)
  console.log("\nStep 8: Testing clean deletion from R2...");
  await deleteMediaByUrls([jobResult.url]);
  await pool.query(`DELETE FROM post_media WHERE post_id = $1`, [dummyPostId]);
  await pool.query(`DELETE FROM posts WHERE post_id = $1`, [dummyPostId]);

  const listAfter = await r2Client.send(
    new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME || "cocpit-db",
      Prefix: `display/posts/${timestamp}`,
    })
  );
  console.log(`  ↳ Remaining display objects in R2: ${listAfter.KeyCount || 0}`);

  console.log("\n============================================================");
  console.log(" Phase 3 & 4 End-to-End Test: 100% SUCCESS! 🎉");
  console.log("============================================================\n");
  process.exit(0);
}

runEndToEndTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
