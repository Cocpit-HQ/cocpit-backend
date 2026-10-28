const crypto = require("crypto");
const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { getStreamPlaybackUrls } = require("../../core/infrastructure/cloudflareStream.client");

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function verifyWebhookSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || !header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const timestamp = Number(parts.time);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS || !parts.sig1) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(parts.sig1, "hex");
  } catch {
    return false;
  }
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function cacheWebhookResult(uid, processingStatus, playback) {
  if (!redisClient?.isOpen) return;
  const rawMasterUrl = await redisClient.get(`media:stream:uid:${uid}`);
  if (!rawMasterUrl) return;
  const cacheKey = `media:conversion:${rawMasterUrl}`;
  const current = await redisClient.get(cacheKey);
  const asset = current ? JSON.parse(current) : { url: rawMasterUrl, masterUrl: rawMasterUrl, mediaType: "video" };
  Object.assign(asset, playback, { processingStatus });
  await redisClient.set(cacheKey, JSON.stringify(asset), "EX", 30 * 86400);
}

async function handleStreamWebhook(payload) {
  const uid = payload?.uid;
  if (!uid || typeof uid !== "string") throw new Error("Stream webhook is missing its video UID.");
  const state = payload.status?.state;
  const isReady = state === "ready" && payload.readyToStream === true;
  const isFailed = state === "error";
  if (!isReady && !isFailed) return { accepted: true, status: "processing" };

  let status = isReady ? "ready" : "failed";
  const playback = getStreamPlaybackUrls(uid);
  if (status === "failed") {
    const currentState = await pool.query("SELECT processing_status FROM post_media WHERE stream_uid = $1 LIMIT 1", [uid]);
    if (currentState.rows[0]?.processing_status === "ready") status = "ready";
  }
  const rows = await pool.query(
    `UPDATE post_media SET processing_status = $1, is_processed = $2,
       stream_hls_url = COALESCE($3, stream_hls_url),
       stream_dash_url = COALESCE($4, stream_dash_url),
       stream_thumbnail_url = COALESCE($5, stream_thumbnail_url),
       processing_error = $6
     WHERE stream_uid = $7
       AND (processing_status IS DISTINCT FROM 'ready' OR $1 = 'ready')
     RETURNING media_id, post_id, master_url`,
    [status, status === "ready", playback.hlsUrl, playback.dashUrl, payload.thumbnail || playback.thumbnailUrl,
      status === "failed" ? String(payload.status?.errReasonText || payload.status?.errorReasonText || "Stream encoding failed.").slice(0, 500) : null, uid]
  );
  await cacheWebhookResult(uid, status, {
    streamUid: uid,
    streamHlsUrl: playback.hlsUrl,
    streamDashUrl: playback.dashUrl,
    streamThumbnailUrl: payload.thumbnail || playback.thumbnailUrl,
  }).catch((error) => console.warn(`[StreamWebhook] Redis result cache failed: ${error.message}`));

  if (rows.rows.length) {
    const socketService = require("../../core/infrastructure/socket.service");
    const postIds = [...new Set(rows.rows.map((row) => row.post_id))];
    const postRows = await pool.query("SELECT post_id, visibility, author_id FROM posts WHERE post_id = ANY($1::uuid[])", [postIds]);
    const posts = new Map(postRows.rows.map((post) => [post.post_id, post]));
    for (const row of rows.rows) {
      const post = posts.get(row.post_id);
      if (status === "failed" && post?.author_id) {
        const { ownedPostRawKey } = require("../../core/infrastructure/postMediaKey");
        const { addVideoFallbackJob } = require("../../queues/videoHdr.queue");
        const rawKey = ownedPostRawKey(row.master_url, post.author_id);
        if (rawKey) void addVideoFallbackJob({ rawKey, rawMasterUrl: row.master_url, ownerId: post.author_id })
          .catch((error) => console.error("[StreamWebhook] Could not queue SDR fallback:", error.message));
      }
      const message = {
        postId: row.post_id,
        mediaId: row.media_id,
        processing_status: status,
        media: {
          media_type: "video",
          stream_uid: uid,
          stream_hls_url: playback.hlsUrl,
          stream_dash_url: playback.dashUrl,
          stream_thumbnail_url: payload.thumbnail || playback.thumbnailUrl,
        },
      };
      if (post?.visibility === "public") socketService.broadcastGlobal?.("media_processing_updated", message);
      else if (post?.author_id) socketService.notifyUser?.(post.author_id, "media_processing_updated", message);
    }
  }
  return { accepted: true, status, updated: rows.rowCount };
}

async function streamWebhook(req, res) {
  const secret = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET;
  if (!secret || !verifyWebhookSignature(req.body, req.get("Webhook-Signature"), secret)) {
    return res.status(401).json({ error: "Invalid Stream webhook signature." });
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid Stream webhook payload." });
  }
  try {
    return res.status(200).json(await handleStreamWebhook(payload));
  } catch (error) {
    console.error("[StreamWebhook] Processing failed:", error.message);
    return res.status(500).json({ error: "Could not process Stream webhook." });
  }
}

module.exports = { streamWebhook, verifyWebhookSignature, handleStreamWebhook };
