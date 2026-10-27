const express = require("express");
const { randomUUID } = require("crypto");
const { uploadStory } = require("../../core/middlewares/upload.middleware");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { generatePresignedUploadUrl, objectExistsInR2, getObjectMetadataFromR2, downloadFromR2AsBuffer, getPublicUrl } = require("../../core/infrastructure/r2.client");
const { processDualAsset } = require("../../workers/mediaTranscoder.worker");
const { validateUploadBatch, validateImageBuffer, MAX_IMAGE_BYTES, MAX_POST_IMAGE_BYTES, MAX_POST_MEDIA_COUNT } = require("./mediaValidation");
const createR2Storage = require("../../core/infrastructure/r2MulterStorage");

const router = express.Router();
const { streamWebhook } = require("./streamWebhook.controller");

router.post("/upload/stream/webhook", streamWebhook);

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare R2 Storage Engine
// Uploads use direct presigned PUT to R2, eliminating server proxy overhead.
// Multipart /upload endpoint also stores directly to R2.
// ─────────────────────────────────────────────────────────────────────────────
const hasR2 = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  (process.env.R2_CDN_BASE_URL || process.env.R2_PUBLIC_URL)
);

console.log(`[UploadRoutes] Cloudflare R2 Storage: ${hasR2 ? "ENABLED ✅ (Direct presigned + R2 multipart)" : "NOT CONFIGURED ⚠️"}`);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: POST /upload/presign
// Generates a presigned PUT URL for the client to upload directly to R2.
// No file bytes pass through this server.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload/presign", requireAuth, async (req, res) => {
  if (!hasR2) {
    return res.status(503).json({
      error: "R2 not configured",
      message: "R2 environment variables are missing.",
    });
  }

  const { filename, contentType } = req.body;

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
    validateUploadBatch([{ filename, contentType, size: Number(req.body.size) }]);
    const ticket = await generatePresignedUploadUrl({ filename, contentType, size: Number(req.body.size), folder: `posts/${req.user.sub}` });
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

router.post("/upload/presign-batch", requireAuth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });
  try {
    const files = req.body?.files;
    validateUploadBatch(files);
    const uploads = await Promise.all(files.map(async (file, index) => {
      const ticket = await generatePresignedUploadUrl({ filename: file.filename || file.name, contentType: file.contentType || file.type, size: Number(file.size), folder: `posts/${req.user.sub}` });
      return { ...ticket, index, filename: file.filename || file.name, contentType: file.contentType || file.type, size: Number(file.size), media_type: String(file.contentType || file.type).startsWith("video/") ? "video" : "image" };
    }));
    return res.json({ uploads, maxImageBytes: MAX_IMAGE_BYTES, maxPostImageBytes: MAX_POST_IMAGE_BYTES, maxFiles: MAX_POST_MEDIA_COUNT });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

const { addTranscodeJob, getJobStatus } = require("../../queues/media.queue");

// Queue a completed direct-to-R2 batch with one authenticated request. The
// browser still uploads each original directly to R2; this call is the signal
// that all PUTs have completed and the worker can begin processing them.
router.post("/upload/process-batch", requireAuth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });

  try {
    const uploads = req.body?.uploads;
    validateUploadBatch(uploads);

    const verifiedUploads = await Promise.all(uploads.map(async (upload) => {
      const { rawKey, rawMasterUrl, mediaType = "image" } = upload;
      if (typeof rawKey !== "string" || !rawKey.startsWith(`raw/posts/${req.user.sub}/`) || rawMasterUrl !== getPublicUrl(rawKey)) {
        throw new Error("Upload does not belong to this user.");
      }
      if (!(await objectExistsInR2(rawKey))) throw new Error(`Raw file ${rawKey} was not found in R2.`);

      const metadata = await getObjectMetadataFromR2(rawKey);
      const maxBytes = (mediaType === "video" ? 100 : 10) * 1024 * 1024;
      if (!metadata.ContentLength || metadata.ContentLength > maxBytes) throw new Error("Uploaded object exceeds the allowed size.");
      if (upload.size && Number(upload.size) !== Number(metadata.ContentLength)) throw new Error("Uploaded object size does not match its upload ticket.");
      return { rawKey, rawMasterUrl, mediaType };
    }));

    const queuedUploads = await Promise.all(verifiedUploads.map(async (upload) => {
      const job = await addTranscodeJob({ ...upload, ownerId: req.user.sub });
      return {
        jobId: job.id,
        status: "processing",
        url: upload.rawMasterUrl,
        master_url: upload.rawMasterUrl,
        media_type: upload.mediaType,
        processing_status: "processing",
        fallback_url: null,
        avif_url: null,
        is_processed: false,
      };
    }));

    return res.status(202).json({ uploads: queuedUploads });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: POST /upload/process
// Called by client AFTER it has successfully PUT the file to R2.
// Decoupled architecture:
//  - Default: Queues compatible JPEG/PNG display-image processing in BullMQ.
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
  if (typeof rawKey !== "string" || !rawKey.startsWith(`raw/posts/${req.user.sub}/`) || rawMasterUrl !== getPublicUrl(rawKey)) {
    return res.status(403).json({ error: "Upload does not belong to this user." });
  }
  const exists = await objectExistsInR2(rawKey);
  if (!exists) {
    return res.status(400).json({
      error: "Raw file not found in R2",
      detail: `Key ${rawKey} does not exist – ensure the presigned PUT completed successfully.`,
    });
  }

  try {
    const objectMetadata = await getObjectMetadataFromR2(rawKey);
    if (!objectMetadata.ContentLength || objectMetadata.ContentLength > (mediaType === "video" ? 100 : 10) * 1024 * 1024) {
      return res.status(400).json({ error: "Uploaded object exceeds the allowed size." });
    }
    if (req.body.size && Number(req.body.size) !== Number(objectMetadata.ContentLength)) {
      return res.status(400).json({ error: "Uploaded object size does not match its upload ticket." });
    }
    if (isSync && mediaType !== "video") {
      console.log(`[UploadRoutes] /upload/process (sync) generating compatible display image: ${rawKey} (${mediaType})`);
      const asset = await processDualAsset({ rawKey, rawMasterUrl, mediaType });
      return res.json({
        status: "completed",
        url: asset.url,              // Compatible JPEG/PNG display URL (or raw video)
        master_url: asset.masterUrl, // 100% untouched raw master
        media_type: asset.mediaType,
        fallback_url: asset.fallbackUrl,
        avif_url: asset.avifUrl,
        processing_status: "ready",
        width: asset.width,
        height: asset.height,
        format: asset.format || "jpeg",
        bit_depth: asset.bitDepth || 8,
        is_processed: true,
      });
    }

    // Asynchronous decoupled BullMQ background queue
    const job = await addTranscodeJob({ rawKey, rawMasterUrl, mediaType, ownerId: req.user.sub });
    console.log(`[UploadRoutes] /upload/process (async) enqueued job ${job.id} for: ${rawKey}`);

    return res.status(202).json({
      jobId: job.id,
      status: "processing",
      url: rawMasterUrl,
      master_url: rawMasterUrl,     // Permanent untouched master
      media_type: mediaType,
      processing_status: "processing",
      fallback_url: null,
      avif_url: null,
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
    if (jobStatus.data?.ownerId !== req.user.sub) return res.status(404).json({ error: "Job not found" });
    return res.json({ id: jobStatus.id, state: jobStatus.state, progress: jobStatus.progress, returnvalue: jobStatus.returnvalue, failedReason: jobStatus.failedReason });
  } catch (err) {
    console.error("[UploadRoutes] Job status error:", err);
    return res.status(500).json({ error: "Failed to get job status", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3: POST /upload  (Multipart upload via Cloudflare R2)
// Fallback for callers unable to use direct presigned PUT
// ─────────────────────────────────────────────────────────────────────────────
const multer = require("multer");
const postUpload = multer({ storage: createR2Storage({ folder: "raw/posts", filename: (req, file) => `${req.user.sub}/${Date.now()}-${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}` }), limits: { fileSize: 100 * 1024 * 1024, files: MAX_POST_MEDIA_COUNT } });
router.post(
  "/upload",
  requireAuth,
  postUpload.array("files", MAX_POST_MEDIA_COUNT),
  async (req, res) => {
    try {
      const files = req.files || [];
      validateUploadBatch(files.map((file) => ({ name: file.originalname, size: file.size, type: file.mimetype })));
      const syncProcessing = req.query.sync === "true";
      const urls = await Promise.all(files.map(async (file) => {
        const rawKey = file.key;
        const rawMasterUrl = file.path;
        if (!rawKey || !rawKey.startsWith(`raw/posts/${req.user.sub}/`)) throw new Error("Upload key is not scoped to the authenticated user.");
        const mediaType = file.mimetype?.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.originalname) ? "video" : "image";
        if (mediaType === "image") validateImageBuffer(await downloadFromR2AsBuffer(rawKey), file.originalname, file.mimetype);
        if (syncProcessing && mediaType !== "video") {
          const asset = await processDualAsset({ rawKey, rawMasterUrl, mediaType });
          return { url: asset.url, master_url: asset.masterUrl, media_type: mediaType, processing_status: "ready", fallback_url: asset.fallbackUrl, avif_url: asset.avifUrl, width: asset.width, height: asset.height, format: asset.format, bit_depth: asset.bitDepth };
        }
        const job = await addTranscodeJob({ rawKey, rawMasterUrl, mediaType, ownerId: req.user.sub });
        return { url: rawMasterUrl, master_url: rawMasterUrl, media_type: mediaType, processing_status: "processing", fallback_url: null, avif_url: null, jobId: job.id };
      }));
      const queuedVideo = files.some((file) => file.mimetype?.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.originalname));
      return res.status(syncProcessing && !queuedVideo ? 200 : 202).json({ urls });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
);

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
      // For video stories, thumbnailUrl defaults to the video URL or display image
      let thumbnailUrl = req.file.path;

      res.json({
        url: req.file.path,
        public_id: req.file.key || req.file.filename || req.file.originalname,
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
