/**
 * Cloudflare R2 Bucket Setup Script
 * ==================================
 * Creates the cocpit-media bucket and configures CORS policy.
 * Run once: node src/scripts/setup-r2-bucket.js
 */

const { S3Client, CreateBucketCommand, PutBucketCorsCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

const BUCKET = process.env.R2_BUCKET_NAME;

const CORS_RULES = [
  {
    AllowedOrigins: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://cocpit.com",
      "https://www.cocpit.com",
      "https://cocpit-frontend-staging.up.railway.app",
      "https://cocpit-backend-staging.up.railway.app",
      // Wildcard for dev environments – tighten in production
      "*",
    ],
    AllowedMethods: ["GET", "PUT", "POST", "HEAD", "DELETE"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
    MaxAgeSeconds: 3600,
  },
];

async function setup() {
  console.log(`\n🪣  Cocpit R2 Bucket Setup`);
  console.log(`   Account  : ${process.env.R2_ACCOUNT_ID}`);
  console.log(`   Bucket   : ${BUCKET}`);
  console.log(`   Endpoint : ${process.env.R2_ENDPOINT}\n`);

  // 1. Check if bucket already exists
  try {
    await r2Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`✅  Bucket "${BUCKET}" already exists – skipping creation.`);
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      // 2. Create the bucket
      console.log(`📦  Creating bucket: ${BUCKET}...`);
      await r2Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      console.log(`✅  Bucket "${BUCKET}" created successfully.`);
    } else {
      console.error(`❌  HeadBucket error:`, err.message);
      throw err;
    }
  }

  // 3. Apply CORS policy (allows browser direct PUT uploads)
  console.log(`\n🌐  Applying CORS policy...`);
  await r2Client.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: CORS_RULES },
    })
  );
  console.log(`✅  CORS rules applied successfully.`);

  console.log(`\n🎉  R2 Bucket Setup Complete!`);
  console.log(`   Public Dev URL : ${process.env.R2_CDN_BASE_URL}`);
  console.log(`   Raw media path : ${process.env.R2_CDN_BASE_URL}/raw/posts/`);
  console.log(`   Display path   : ${process.env.R2_CDN_BASE_URL}/display/posts/`);
  console.log(`\n   Next steps:`);
  console.log(`   1. Enable R2 public access in the Cloudflare Dashboard`);
  console.log(`   2. (Optional) Connect custom domain cdn.cocpit.com`);
  console.log(`   3. Start the backend – /upload/presign endpoint is now active\n`);
}

setup().catch(err => {
  console.error("❌  Setup failed:", err.message);
  process.exit(1);
});
