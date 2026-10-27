const { S3Client, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

const hasR2 = Boolean(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

const r2Client = hasR2
  ? new S3Client({
      region: "auto",
      endpoint:
        process.env.R2_ENDPOINT ||
        `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const bucketName = process.env.R2_BUCKET_NAME || "cocpit-db";
const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

/**
 * Extracts the S3/R2 object key from a full public CDN URL or relative path.
 * Examples:
 *   "https://pub-9ab7b27b805e4ef3954360339e67917a.r2.dev/posts/123.jpg" -> "posts/123.jpg"
 *   "https://cdn.cocpit.in/avatars/456.png" -> "avatars/456.png"
 *   "posts/123.jpg" -> "posts/123.jpg"
 */
function extractR2Key(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;
  if (urlOrKey.includes("res.cloudinary.com") || urlOrKey.includes("googleusercontent.com")) {
    return null;
  }
  if (!urlOrKey.startsWith("http://") && !urlOrKey.startsWith("https://")) {
    return urlOrKey.replace(/^\/+/, "");
  }
  try {
    const parsed = new URL(urlOrKey);
    const key = parsed.pathname.replace(/^\/+/, "");
    return key || null;
  } catch (e) {
    return null;
  }
}

/**
 * Checks whether an asset exists in Cloudflare R2
 */
async function checkR2AssetExists(urlOrKey) {
  if (!hasR2 || !r2Client || !urlOrKey) return false;
  const key = extractR2Key(urlOrKey);
  if (!key) return false;

  try {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    await r2Client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Deletes a single object from Cloudflare R2 given its URL or Key
 */
async function deleteR2Asset(urlOrKey) {
  if (!hasR2 || !r2Client || !urlOrKey) return false;
  const key = extractR2Key(urlOrKey);
  if (!key) return false;

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
    console.log(`[R2] Successfully deleted asset: ${key}`);
    return true;
  } catch (err) {
    console.error(`[R2] Error deleting asset ${key}:`, err.message);
    return false;
  }
}

/**
 * Batch deletes multiple objects from Cloudflare R2 given an array of URLs or Keys
 */
async function deleteR2Assets(urlsOrKeys) {
  if (!hasR2 || !r2Client || !Array.isArray(urlsOrKeys) || urlsOrKeys.length === 0) return false;
  const objects = urlsOrKeys
    .map(extractR2Key)
    .filter(Boolean)
    .map((Key) => ({ Key }));

  if (objects.length === 0) return false;

  try {
    await r2Client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      })
    );
    console.log(`[R2] Successfully batch deleted ${objects.length} assets`);
    return true;
  } catch (err) {
    console.error(`[R2] Error batch deleting assets:`, err.message);
    return false;
  }
}

module.exports = {
  r2Client,
  hasR2,
  bucketName,
  publicUrl,
  extractR2Key,
  checkR2AssetExists,
  deleteR2Asset,
  deleteR2Assets,
};
