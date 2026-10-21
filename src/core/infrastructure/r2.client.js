const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare R2 Client Configuration
// Endpoint: https://<accountId>.r2.cloudflarestorage.com (S3-compatible)
// ─────────────────────────────────────────────────────────────────────────────
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT, // e.g. https://dfb9645beb803038c3b1e89183cdc126.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // Cloudflare R2 requires path-style URLs (not virtual hosted)
  forcePathStyle: false,
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const CDN_BASE_URL = process.env.R2_CDN_BASE_URL; // e.g. https://pub-xxx.r2.dev OR custom CDN domain

/**
 * Derive a clean CDN public URL for an R2 object key.
 * Uses the public dev URL or a custom CDN domain if configured.
 * @param {string} key - R2 object key (e.g. raw/posts/1234-file.jpg)
 * @returns {string} - Public CDN URL
 */
function getPublicUrl(key) {
  if (!CDN_BASE_URL) {
    throw new Error("[R2Client] R2_CDN_BASE_URL env var is not set.");
  }
  return `${CDN_BASE_URL.replace(/\/$/, "")}/${key}`;
}

/**
 * Generate a presigned PUT URL so the client uploads directly to R2.
 * The server never touches the raw file bytes, eliminating proxy overhead.
 *
 * @param {object} opts
 * @param {string} opts.filename      - Original file name (sanitized internally)
 * @param {string} opts.contentType   - MIME type of the file
 * @param {string} [opts.folder]      - Logical folder prefix (default: "posts")
 * @param {number} [opts.expiresIn]   - Signed URL TTL in seconds (default: 1800 = 30 min)
 * @returns {Promise<{uploadUrl, rawKey, rawMasterUrl}>}
 */
async function generatePresignedUploadUrl({ filename, contentType, folder = "posts", expiresIn = 1800 }) {
  if (!R2_BUCKET) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");

  const timestamp = Date.now();
  const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const rawKey = `raw/${folder}/${timestamp}-${sanitizedName}`;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: rawKey,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn });
  const rawMasterUrl = getPublicUrl(rawKey);

  console.log(`[R2Client] Generated presigned PUT URL for key: ${rawKey}`);

  return {
    uploadUrl,   // Client PUT directly to this URL
    rawKey,      // Used by backend to trigger processing
    rawMasterUrl // Permanent public URL of raw master
  };
}

/**
 * Stream the raw object from R2 into a Buffer (used by the transcoder worker).
 * @param {string} key - R2 object key
 * @returns {Promise<Buffer>}
 */
async function downloadFromR2AsBuffer(key) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  const response = await r2Client.send(cmd);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a buffer directly to R2 (used by the transcoder to store processed AVIF).
 * @param {object} opts
 * @param {string} opts.key           - Target R2 key
 * @param {Buffer} opts.body          - File contents
 * @param {string} opts.contentType   - MIME type
 * @param {string} [opts.cacheControl] - Cache header (default: 1 year immutable)
 */
async function uploadBufferToR2({ key, body, contentType, cacheControl = "public, max-age=31536000, immutable" }) {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
  const publicUrl = getPublicUrl(key);
  console.log(`[R2Client] Uploaded buffer to R2: ${key} → ${publicUrl}`);
  return publicUrl;
}

/**
 * Batch delete objects from R2 (used by story expiry worker).
 * @param {string[]} keys - Array of R2 object keys to delete
 */
async function deleteObjectsFromR2(keys) {
  if (!keys || keys.length === 0) return;
  await r2Client.send(
    new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
        Quiet: true,
      },
    })
  );
  console.log(`[R2Client] Deleted ${keys.length} objects from R2.`);
}

/**
 * Check if an R2 object exists (used for validation / orphan detection).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function objectExistsInR2(key) {
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  r2Client,
  getPublicUrl,
  generatePresignedUploadUrl,
  downloadFromR2AsBuffer,
  uploadBufferToR2,
  deleteObjectsFromR2,
  objectExistsInR2,
};
