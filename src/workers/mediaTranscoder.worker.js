const sharp = require("sharp");
const libheif = require("libheif-js/wasm-bundle");
const { downloadFromR2AsBuffer, uploadBufferToR2, getPublicUrl } = require("../core/infrastructure/r2.client");
const { Worker } = require("bullmq");
const { redisConnection } = require("../queues/media.queue");
const redisClient = require("../core/db/redis");
const pool = require("../core/db/pool");
const { detectImageMime, validateImageBuffer } = require("../modules/upload/mediaValidation");
const { isStreamConfigured, createStreamVideoFromUrl } = require("../core/infrastructure/cloudflareStream.client");
const { addVideoHdrJob } = require("../queues/videoHdr.queue");

const MAX_DISPLAY_PX = 2560;
const MAX_INPUT_PIXELS = 100_000_000;
if (!libheif.HeifDecoder) throw new Error("HEIC/HEIF decoder failed to initialize.");

function deriveDisplayKey(rawKey, extension = ".jpg") {
  const noExt = rawKey.replace(/\.[^/.]+$/, "");
  return noExt.replace(/^raw\//, "display/") + extension;
}

async function decodeHeif(rawBuffer) {
  const decoder = new libheif.HeifDecoder();
  try {
    const images = decoder.decode(rawBuffer);
    const image = images?.[0];
    if (!image) throw new Error("No image was found in the HEIF file.");
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height || width * height > MAX_INPUT_PIXELS) throw new Error("Image dimensions exceed the processing limit.");
    const pixels = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => {
      image.display({ data: pixels, width, height }, (result) => result ? resolve() : reject(new Error("HEIF decoding failed.")));
    });
    return { input: Buffer.from(pixels), options: { raw: { width, height, channels: 4 } }, width, height };
  } finally {
    decoder.decoder?.delete?.();
  }
}

async function transcodeImage(rawBuffer, rawKey) {
  const detectedMime = detectImageMime(rawBuffer);
  if (!detectedMime) throw new Error("Unsupported or invalid image content.");
  validateImageBuffer(rawBuffer, rawKey, detectedMime);

  const heif = detectedMime === "image/heic";
  const decoded = heif ? await decodeHeif(rawBuffer) : null;
  const input = decoded?.input || rawBuffer;
  const options = decoded?.options || { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS };
  const source = sharp(input, options);
  const metadata = await source.metadata();
  const width = decoded?.width || metadata.width;
  const height = decoded?.height || metadata.height;
  if (!width || !height || width * height > MAX_INPUT_PIXELS) throw new Error("Image dimensions exceed the processing limit.");

  const base = sharp(input, options).rotate().resize({ width: MAX_DISPLAY_PX, height: MAX_DISPLAY_PX, fit: "inside", withoutEnlargement: true }).withIccProfile("p3");
  let hasAlpha = heif ? false : Boolean(metadata.hasAlpha);
  if (heif && !hasAlpha) {
    const pixels = decoded.input;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) { hasAlpha = true; break; }
    }
  }
  const fallbackFormat = hasAlpha ? "png" : "jpeg";
  const fallbackMime = hasAlpha ? "image/png" : "image/jpeg";
  const fallbackExt = hasAlpha ? ".png" : ".jpg";
  const fallbackResult = await (hasAlpha
    ? base.clone().png({ compressionLevel: 9, effort: 7, palette: false }).toBuffer({ resolveWithObject: true })
    : base.clone().jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer({ resolveWithObject: true }));
  const fallbackKey = deriveDisplayKey(rawKey, fallbackExt);
  const fallbackUrl = await uploadBufferToR2({ key: fallbackKey, body: fallbackResult.data, contentType: fallbackMime });

  return {
    url: fallbackUrl,
    fallbackUrl,
    avifUrl: null,
    masterUrl: getPublicUrl(rawKey),
    mediaType: "image",
    width: fallbackResult.info.width,
    height: fallbackResult.info.height,
    format: fallbackFormat,
    bitDepth: fallbackFormat === "png" ? 8 : 8,
    originalWidth: width,
    originalHeight: height,
    originalFormat: detectedMime.slice("image/".length),
  };
}

async function processDualAsset({ rawKey, rawMasterUrl, mediaType = "image" }) {
  if (mediaType === "video") {
    return { url: rawMasterUrl, fallbackUrl: rawMasterUrl, avifUrl: null, masterUrl: rawMasterUrl, mediaType: "video", width: null, height: null, format: "original", bitDepth: null };
  }
  return transcodeImage(await downloadFromR2AsBuffer(rawKey), rawKey);
}

async function saveProcessingResult(rawMasterUrl, asset, status = "ready", errorMessage = null) {
  const result = await pool.query(
    `UPDATE post_media
     SET url = $1, fallback_url = $2, avif_url = $3, width = $4, height = $5,
         format = $6, bit_depth = $7, is_processed = $8, processing_status = $9,
         processing_error = $10
     WHERE master_url = $11 OR url = $11
     RETURNING post_id, media_id`,
    [asset.url, asset.fallbackUrl, asset.avifUrl, asset.width, asset.height, asset.format, asset.bitDepth, status === "ready", status, errorMessage, rawMasterUrl]
  );
  return result.rows;
}

async function notifyProcessingUpdate(rows, ownerId, status, mediaAsset = null) {
  if (!rows.length) return;
  const socketService = require("../core/infrastructure/socket.service");
  const postIds = [...new Set(rows.map((row) => row.post_id))];
  const postRows = await pool.query("SELECT post_id, visibility FROM posts WHERE post_id = ANY($1::uuid[])", [postIds]);
  const publicPosts = new Set(postRows.rows.filter((post) => post.visibility === "public").map((post) => post.post_id));
  for (const row of rows) {
    const payload = {
      postId: row.post_id,
      mediaId: row.media_id,
      processing_status: status,
      media: mediaAsset ? {
        url: mediaAsset.url,
        fallback_url: mediaAsset.fallbackUrl || null,
        avif_url: mediaAsset.avifUrl || null,
        width: mediaAsset.width || null,
        height: mediaAsset.height || null,
        media_type: mediaAsset.mediaType || "image",
        stream_uid: mediaAsset.streamUid || null,
        stream_hls_url: mediaAsset.streamHlsUrl || null,
        stream_dash_url: mediaAsset.streamDashUrl || null,
        stream_thumbnail_url: mediaAsset.streamThumbnailUrl || null,
        hdr_manifest_url: mediaAsset.hdrManifestUrl || null,
        hdr_processing_status: mediaAsset.hdrProcessingStatus || null,
      } : null,
    };
    if (publicPosts.has(row.post_id)) socketService.broadcastGlobal?.("media_processing_updated", payload);
    else socketService.notifyUser?.(ownerId, "media_processing_updated", payload);
  }
}

let mediaWorkerInstance = null;

function startMediaTranscoderWorker() {
  if (mediaWorkerInstance) return mediaWorkerInstance;
  mediaWorkerInstance = new Worker("media-transcode", async (job) => {
    const { rawKey, rawMasterUrl, mediaType = "image", ownerId } = job.data;
    if (mediaType === "video") {
      if (!isStreamConfigured()) throw new Error("Cloudflare Stream is not fully configured for adaptive video playback.");
      await addVideoHdrJob({ rawKey, rawMasterUrl, ownerId });
      const streamResult = await createStreamVideoFromUrl({ url: rawMasterUrl, creator: ownerId, name: rawKey.split("/").pop() });
      const asset = {
        url: rawMasterUrl,
        masterUrl: rawMasterUrl,
        fallbackUrl: rawMasterUrl,
        mediaType: "video",
        streamUid: streamResult?.uid || null,
        streamHlsUrl: streamResult?.hlsUrl || null,
        streamDashUrl: streamResult?.dashUrl || null,
        streamThumbnailUrl: streamResult?.thumbnailUrl || null,
        processingStatus: "processing",
        hdrProcessingStatus: "processing",
      };
      try {
        if (redisClient?.isOpen) {
          const cacheKey = `media:conversion:${rawMasterUrl}`;
          const current = await redisClient.get(cacheKey);
          const cachedAsset = current ? JSON.parse(current) : {};
          await redisClient.set(cacheKey, JSON.stringify({ ...cachedAsset, ...asset,
            hdrManifestUrl: cachedAsset.hdrManifestUrl || null,
            hdrProcessingStatus: cachedAsset.hdrProcessingStatus || asset.hdrProcessingStatus,
          }), "EX", 30 * 86400);
          if (streamResult) await redisClient.set(`media:stream:uid:${streamResult.uid}`, rawMasterUrl, "EX", 30 * 86400);
        }
      } catch (error) {
        console.warn(`[MediaTranscoder] Video result cache failed: ${error.message}`);
      }
      const rows = await pool.query(
        `UPDATE post_media SET stream_uid = $1, stream_hls_url = $2, stream_dash_url = $3,
           stream_thumbnail_url = $4, processing_status = $5, is_processed = $6,
           hdr_processing_status = 'processing'
         WHERE master_url = $7 OR url = $7 RETURNING post_id, media_id`,
        [asset.streamUid, asset.streamHlsUrl, asset.streamDashUrl, asset.streamThumbnailUrl,
          asset.processingStatus, asset.processingStatus === "ready", rawMasterUrl]
      );
      if (rows.rows.length) await notifyProcessingUpdate(rows.rows, ownerId, asset.processingStatus, asset);
      return asset;
    }

    const asset = await processDualAsset({ rawKey, rawMasterUrl, mediaType });
    try {
      if (redisClient?.isOpen) {
        await redisClient.set(`media:conversion:${rawMasterUrl}`, JSON.stringify(asset), "EX", 86400);
      }
    } catch (error) {
      console.warn(`[MediaTranscoder] Redis result cache failed: ${error.message}`);
    }
    const rows = await saveProcessingResult(rawMasterUrl, asset);
    await notifyProcessingUpdate(rows, ownerId, "ready", asset);
    return asset;
  }, { connection: redisConnection, concurrency: 3 });

  mediaWorkerInstance.on("completed", (job) => console.log(`[MediaTranscoder] Job ${job.id} completed.`));
  mediaWorkerInstance.on("failed", async (job, error) => {
    console.error(`[MediaTranscoder] Job ${job?.id} failed:`, error.message);
    if (!job || job.attemptsMade < (job.opts?.attempts || 1)) return;
    try {
      if (redisClient?.isOpen) {
        await redisClient.set(`media:conversion:${job.data.rawMasterUrl}`, JSON.stringify({
          url: job.data.rawMasterUrl,
          masterUrl: job.data.rawMasterUrl,
          fallbackUrl: null,
          avifUrl: null,
          processingStatus: "failed",
          error: String(error.message).slice(0, 500),
        }), "EX", 86400);
      }
    } catch (redisErr) {
      console.warn(`[MediaTranscoder] Redis failed cache error: ${redisErr.message}`);
    }
    try {
      const rows = await pool.query(
        `UPDATE post_media SET processing_status = 'failed', processing_error = $1,
           url = COALESCE(master_url, url), is_processed = FALSE
         WHERE master_url = $2 RETURNING post_id, media_id, master_url`,
        [String(error.message).slice(0, 500), job.data.rawMasterUrl]
      );
      await notifyProcessingUpdate(rows.rows, job.data.ownerId, "failed", {
        url: rows.rows[0]?.master_url || job.data.rawMasterUrl,
        mediaType: job.data.mediaType || "image",
      });
    } catch (dbError) {
      console.error(`[MediaTranscoder] Could not save failed state: ${dbError.message}`);
    }
  });
  mediaWorkerInstance.on("error", (error) => console.error("[MediaTranscoder] Worker error:", error.message));
  return mediaWorkerInstance;
}

async function closeMediaTranscoderWorker() {
  if (!mediaWorkerInstance) return;
  await mediaWorkerInstance.close();
  mediaWorkerInstance = null;
}

module.exports = { transcodeImageToCompatibleFormat: (rawKey) => downloadFromR2AsBuffer(rawKey).then((buffer) => transcodeImage(buffer, rawKey)), processDualAsset, deriveDisplayKey, startMediaTranscoderWorker, closeMediaTranscoderWorker };
