const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const { randomUUID } = require("crypto");

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare R2 Client Configuration
// Endpoint: https://<accountId>.r2.cloudflarestorage.com (S3-compatible)
// ─────────────────────────────────────────────────────────────────────────────
const r2Endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : undefined);

const r2Client = new S3Client({
  region: "auto",
  endpoint: r2Endpoint, // R2's S3-compatible endpoint
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const getBucketName = () => process.env.R2_BUCKET_NAME || "";
const getCdnBaseUrl = () => (process.env.R2_PUBLIC_URL || process.env.R2_CDN_BASE_URL || "").replace(/\/$/, "");

/**
 * Derive a clean CDN public URL for an R2 object key.
 * Uses the public dev URL or a custom CDN domain if configured.
 * @param {string} key - R2 object key (e.g. raw/posts/1234-file.jpg)
 * @returns {string} - Public CDN URL
 */
function getPublicUrl(key) {
  const cdn = getCdnBaseUrl();
  if (!cdn) {
    throw new Error("[R2Client] Set R2_PUBLIC_URL or R2_CDN_BASE_URL.");
  }
  return `${cdn}/${key}`;
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
async function generatePresignedUploadUrl({ filename, contentType, size, folder = "posts", ownerId, expiresIn = 1800 }) {
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");

  const timestamp = Date.now();
  const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  // Keep post objects directly under raw/posts. The owner is encoded in the
  // basename so existing upload routes can still enforce ownership.
  const ownerPrefix = ownerId ? `${ownerId}-` : "";
  const rawKey = `raw/${folder}/${ownerPrefix}${timestamp}-${randomUUID()}-${sanitizedName}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: rawKey,
    ContentType: contentType,
    ...(Number.isFinite(Number(size)) ? { ContentLength: Number(size) } : {}),
  });

  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn });
  const rawMasterUrl = getPublicUrl(rawKey);

  console.log(`[R2Client] Generated presigned PUT URL for key: ${rawKey} in bucket '${bucket}'`);

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
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await r2Client.send(cmd);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadFromR2ToFile(key, filePath) {
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");
  const response = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`[R2Client] R2 returned an empty body for ${key}.`);
  await pipeline(response.Body, fs.createWriteStream(filePath));
  return filePath;
}

async function uploadFileToR2({ key, filePath, contentType, cacheControl = "public, max-age=31536000, immutable" }) {
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");
  await r2Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
  return getPublicUrl(key);
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
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
  const publicUrl = getPublicUrl(key);
  console.log(`[R2Client] Uploaded buffer to R2 (${bucket}): ${key} → ${publicUrl}`);
  return publicUrl;
}

/**
 * Batch delete objects from R2.
 * @param {string[]} keys - Array of R2 object keys to delete
 */
async function deleteObjectsFromR2(keys) {
  if (!keys || keys.length === 0) return;
  const bucket = getBucketName();
  if (!bucket) {
    console.warn("[R2Client] R2_BUCKET_NAME not set, cannot delete objects.");
    return;
  }

  // S3 DeleteObjects max limit is 1000 per batch
  const batchSize = 1000;
  for (let i = 0; i < keys.length; i += batchSize) {
    const chunk = keys.slice(i, i + batchSize);
    const response = await r2Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
    if (response.Errors?.length) {
      const failedKeys = response.Errors.map(({ Key, Code }) => `${Key || "unknown"} (${Code || "unknown error"})`);
      throw new Error(`[R2Client] Failed to delete R2 objects: ${failedKeys.join(", ")}`);
    }
  }
  console.log(`[R2Client] Deleted ${keys.length} objects from R2 bucket '${bucket}'.`);
}

async function deleteR2Prefix(prefix) {
  const bucket = getBucketName();
  if (!bucket || !prefix) return;
  let continuationToken;
  do {
    const page = await r2Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const keys = (page.Contents || []).map((item) => item.Key).filter(Boolean);
    if (keys.length) await deleteObjectsFromR2(keys);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Check if an R2 object exists (used for validation / orphan detection).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function objectExistsInR2(key) {
  try {
    const bucket = getBucketName();
    if (!bucket) return false;
    await r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function getObjectMetadataFromR2(key) {
  const bucket = getBucketName();
  if (!bucket) throw new Error("[R2Client] R2_BUCKET_NAME env var is not set.");
  return r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Given one or more media URLs or objects ({url}), find all related R2 keys
 * (both display variant and raw master) and delete them from the active R2 bucket.
 *
 * @param {string|object|Array<string|object>} mediaInput
 */
async function deleteMediaByUrls(mediaInput) {
  if (!mediaInput) return;
  const list = Array.isArray(mediaInput) ? mediaInput : [mediaInput];
  if (list.length === 0) return;

  const bucket = getBucketName();
  if (!bucket) {
    console.warn("[R2Client] R2_BUCKET_NAME not configured, skipping media deletion.");
    return;
  }

  const keysToDelete = new Set();
  const configuredPublicBases = [process.env.R2_PUBLIC_URL, process.env.R2_CDN_BASE_URL]
    .filter(Boolean)
    .map((base) => base.replace(/\/$/, ""));

  for (const item of list) {
    const rawUrl = typeof item === "object" && item !== null ? (item.master_url || item.masterUrl || item.url) : item;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    // Check if URL belongs to R2
    const isRawKey = rawUrl.startsWith("display/") || rawUrl.startsWith("raw/");
    let isConfiguredPublicUrl = false;
    if (/^https?:\/\//i.test(rawUrl)) {
      try {
        const parsed = new URL(rawUrl);
        isConfiguredPublicUrl = configuredPublicBases.some((base) => {
          try {
            const configured = new URL(base);
            return parsed.origin === configured.origin && parsed.pathname.startsWith(`${configured.pathname.replace(/\/$/, "")}/`);
          } catch {
            return false;
          }
        });
      } catch {
        // Ignore malformed URLs; they are not safe to use as R2 object keys.
      }
    }
    const isR2 = isRawKey || isConfiguredPublicUrl;

    if (!isR2) {
      console.log(`[R2Client] Skipping non-R2 media deletion: ${rawUrl}`);
      continue;
    }

    try {
      let pathname = rawUrl;
      if (/^https?:\/\//i.test(rawUrl)) {
        const parsed = new URL(rawUrl);
        const matchedBase = configuredPublicBases
          .map((base) => new URL(base))
          .find((base) => parsed.origin === base.origin && parsed.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`));
        if (!matchedBase) continue;
        pathname = parsed.pathname.slice(matchedBase.pathname.replace(/\/$/, "").length);
      }
      try {
        pathname = decodeURIComponent(pathname);
      } catch {
        console.warn("[R2Client] Skipping media URL with invalid path encoding.");
        continue;
      }
      pathname = pathname.replace(/^\/+/, "");

      // Add the exact key found
      keysToDelete.add(pathname);

      // Extract folder and base name without extension
      // Format: (display|raw)/<folder>/<timestamp>-<name>.<ext>
      const match = pathname.match(/^(?:display|raw)\/([^/]+)\/(.+?)(\.[^./]+)?$/);
      if (match) {
        const folder = match[1];   // e.g. "posts"
        const baseName = match[2]; // e.g. "1792574189433-downloaded_stored"

        // Search for any raw files matching raw/<folder>/<baseName>
        try {
          const rawList = await r2Client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: `raw/${folder}/${baseName}`,
            })
          );
          if (rawList.Contents) {
            for (const obj of rawList.Contents) {
              if (obj.Key) keysToDelete.add(obj.Key);
            }
          }
        } catch (e) {
          console.error(`[R2Client] Error listing raw objects for prefix raw/${folder}/${baseName}:`, e.message);
        }

        // Search for any display files matching display/<folder>/<baseName>
        try {
          const displayList = await r2Client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: `display/${folder}/${baseName}`,
            })
          );
          if (displayList.Contents) {
            for (const obj of displayList.Contents) {
              if (obj.Key) keysToDelete.add(obj.Key);
            }
          }
        } catch (e) {
          console.error(`[R2Client] Error listing display objects for prefix display/${folder}/${baseName}:`, e.message);
        }
      }
    } catch (err) {
      console.error(`[R2Client] Error parsing media URL for deletion (${rawUrl}):`, err.message);
    }
  }

  if (keysToDelete.size > 0) {
    const keysArray = Array.from(keysToDelete);
    console.log(`[R2Client] Deleting ${keysArray.length} objects from bucket '${bucket}':`, keysArray);
    await deleteObjectsFromR2(keysArray);
  } else {
    console.log("[R2Client] No matching R2 keys found to delete.");
  }
}

module.exports = {
  r2Client,
  getPublicUrl,
  generatePresignedUploadUrl,
  downloadFromR2AsBuffer,
  downloadFromR2ToFile,
  uploadBufferToR2,
  uploadFileToR2,
  deleteObjectsFromR2,
  deleteR2Prefix,
  objectExistsInR2,
  getObjectMetadataFromR2,
  deleteMediaByUrls,
};

