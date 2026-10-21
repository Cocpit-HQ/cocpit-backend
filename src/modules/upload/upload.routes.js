const express = require("express");
const { uploadStory } = require("../../core/middlewares/upload.middleware");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { generatePresignedUploadUrl, objectExistsInR2 } = require("../../core/infrastructure/r2.client");
const { processDualAsset } = require("../../workers/mediaTranscoder.worker");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// R2 Feature Flag
// When R2 is configured, uploads bypass the backend entirely (presigned PUT).
// When R2 is NOT configured (local dev without creds), fall through to legacy
// multer→cloudinary flow for backwards compatibility.
// ─────────────────────────────────────────────────────────────────────────────
const hasR2 = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_CDN_BASE_URL
);

console.log(`[UploadRoutes] R2 mode: ${hasR2 ? "ENABLED ✅ (Direct presigned uploads)" : "DISABLED ⚠️ (Legacy Cloudinary fallback)"}`);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: POST /upload/presign
// Generates a presigned PUT URL for the client to upload directly to R2.
// No file bytes pass through this server.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload/presign", requireAuth, async (req, res) => {
  if (!hasR2) {
    return res.status(503).json({
      error: "R2 not configured",
      message: "R2 environment variables are missing. Use /upload (legacy) endpoint.",
    });
  }

  const { filename, contentType, folder = "posts" } = req.body;

  if (!filename || !contentType) {
    return res.status(400).json({ error: "Missing required fields: filename, contentType" });
  }

  // Validate MIME type – only allow known safe types
  const ALLOWED_TYPES = [
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/heic", "image/heif", "image/avif",
    "video/mp4", "video/mov", "video/quicktime", "video/webm",
  ];
  if (!ALLOWED_TYPES.includes(contentType)) {
    return res.status(400).json({ error: `Unsupported content type: ${contentType}` });
  }

  try {
    const ticket = await generatePresignedUploadUrl({ filename, contentType, folder });
    console.log(`[UploadRoutes] /upload/presign issued for user ${req.user.sub}: ${ticket.rawKey}`);

    return res.json({
      uploadUrl: ticket.uploadUrl,    // Client PUT directly to R2
      rawKey: ticket.rawKey,          // Used in /upload/process call
      rawMasterUrl: ticket.rawMasterUrl, // Permanent raw master CDN URL
    });
  } catch (err) {
    console.error("[UploadRoutes] Presign error:", err);
    return res.status(500).json({ error: "Failed to generate upload URL", details: err.message });
  }
});

const { addTranscodeJob, getJobStatus } = require("../../queues/media.queue");

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: POST /upload/process
// Called by client AFTER it has successfully PUT the file to R2.
// Decoupled architecture:
//  - Default: Queues 12-bit AVIF transcoding to BullMQ background worker (<15ms response).
//             Returns immediately with rawMasterUrl so client can post without waiting.
//  - sync=true: Executes transcoding immediately in-request (for scripts/verification).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload/process", requireAuth, async (req, res) => {
  if (!hasR2) {
    return res.status(503).json({ error: "R2 not configured" });
  }

  const { rawKey, rawMasterUrl, mediaType = "image", sync = false } = req.body;
  const isSync = sync === true || req.query.sync === "true";

  if (!rawKey || !rawMasterUrl) {
    return res.status(400).json({ error: "Missing required fields: rawKey, rawMasterUrl" });
  }

  // Verify the upload actually landed in R2 before processing
  const exists = await objectExistsInR2(rawKey);
  if (!exists) {
    return res.status(400).json({
      error: "Raw file not found in R2",
      detail: `Key ${rawKey} does not exist – ensure the presigned PUT completed successfully.`,
    });
  }

  try {
    if (isSync) {
      console.log(`[UploadRoutes] /upload/process (sync) running dual-asset pipeline: ${rawKey} (${mediaType})`);
      const asset = await processDualAsset({ rawKey, rawMasterUrl, mediaType });
      return res.json({
        status: "completed",
        url: asset.url,              // 12-bit AVIF display URL (or raw video)
        master_url: asset.masterUrl, // 100% untouched raw master
        media_type: asset.mediaType,
        width: asset.width,
        height: asset.height,
        format: asset.format || "avif",
        bit_depth: asset.bitDepth || 12,
        is_processed: true,
      });
    }

    // Asynchronous decoupled BullMQ background queue (<15ms response)
    const job = await addTranscodeJob({ rawKey, rawMasterUrl, mediaType });
    console.log(`[UploadRoutes] /upload/process (async) enqueued job ${job.id} for: ${rawKey}`);

    return res.status(202).json({
      jobId: job.id,
      status: "processing",
      url: rawMasterUrl,            // Instant raw master display while AVIF processes in worker
      master_url: rawMasterUrl,     // Permanent untouched master
      media_type: mediaType,
      is_processed: false,
    });
  } catch (err) {
    console.error("[UploadRoutes] Processing error:", err);
    return res.status(500).json({ error: "Media processing failed", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2B: GET /upload/job/:jobId
// Poll status of an asynchronous background transcode job.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/upload/job/:jobId", requireAuth, async (req, res) => {
  try {
    const jobStatus = await getJobStatus(req.params.jobId);
    if (!jobStatus) {
      return res.status(404).json({ error: "Job not found" });
    }
    return res.json(jobStatus);
  } catch (err) {
    console.error("[UploadRoutes] Job status error:", err);
    return res.status(500).json({ error: "Failed to get job status", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3: POST /upload  (LEGACY – Cloudinary fallback, kept for backwards compatibility)
// Used when R2 is not configured (local dev) or for non-R2 environments.
// This path still proxies through Express → Cloudinary.
// ─────────────────────────────────────────────────────────────────────────────
if (!hasR2) {
  // Only register the heavy multer route when R2 is NOT available
  const { upload } = require("../../core/middlewares/upload.middleware");
  router.post(
    "/upload",
    upload.array("files", 12),
    (req, res) => {
      console.log("[UploadRoute:Legacy] Uploaded files via Cloudinary:", req.files?.length);
      const urls = req.files.map(file => ({
        url: file.path,
        media_type: file.resource_type || (file.mimetype?.startsWith("video") ? "video" : "image"),
        width: file.width || null,
        height: file.height || null,
      }));
      res.json({ urls });
    }
  );
} else {
  // In R2 mode, reject any attempt to use the old multipart upload route
  router.post("/upload", (req, res) => {
    return res.status(410).json({
      error: "Legacy upload endpoint disabled",
      message: "Use POST /upload/presign + POST /upload/process for direct R2 uploads.",
      docs: "See SCALABLE_MEDIA_ARCHITECTURE_PLAN.md for the new upload flow.",
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4: POST /upload/story  (Story upload – still uses multer until Phase 4 migration)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/upload/story",
  uploadStory.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    try {
      const mediaType = req.file.mimetype.startsWith("video") ? "video" : "image";
      let thumbnailUrl = req.file.path;

      // Legacy: generate Cloudinary thumbnail URL if not using R2 yet
      if (!hasR2 && req.file.filename) {
        try {
          const cloudinary = require("../../core/infrastructure/cloudinary.client");
          if (cloudinary.url) {
            thumbnailUrl = cloudinary.url(req.file.filename, {
              resource_type: "video",
              format: "jpg",
              transformation: [{ width: 720, aspectRatio: "9:16", crop: "fill" }],
            });
          }
        } catch (e) {
          console.error("Error generating thumbnail URL:", e);
        }
      }

      res.json({
        url: req.file.path,
        public_id: req.file.filename || req.file.originalname,
        media_type: mediaType,
        thumbnail_url: thumbnailUrl,
      });
    } catch (err) {
      console.error("[UploadRoute] Story upload handler error:", err);
      res.status(500).json({ message: "Internal server error", error: err.message });
    }
  }
);

module.exports = router;
