const { Worker } = require("bullmq");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const { r2Client, uploadFileToR2, getPublicUrl } = require("../core/infrastructure/r2.client");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getRedisConnectionOptions } = require("../queues/media.queue");
const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");

const execFile = promisify(require("child_process").execFile);
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const RENDITIONS = [
  { height: 2160, bitrate: "20M" },
  { height: 1080, bitrate: "10M" },
  { height: 720, bitrate: "5M" },
  { height: 480, bitrate: "2.5M" },
  { height: 360, bitrate: "1.2M" },
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

async function downloadR2Object(rawKey, destination) {
  const response = await r2Client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: rawKey,
  }));
  if (!response.Body) throw new Error("R2 returned an empty video body.");
  await pipeline(response.Body, fs.createWriteStream(destination));
}

async function inspectVideo(sourcePath) {
  const { stdout } = await execFile(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,pix_fmt,color_transfer,color_primaries,color_space,profile,level",
    "-of", "json", sourcePath,
  ], { maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("Video has no readable video stream.");
  return {
    ...stream,
    isHdr: HDR_TRANSFERS.has(stream.color_transfer) && stream.color_primaries === "bt2020",
  };
}

async function verifyVideoTools() {
  await run(process.env.FFPROBE_PATH || "ffprobe", ["-version"]);
  const { stdout, stderr } = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-encoders"]);
  if (!`${stdout}\n${stderr}`.includes("libx265")) {
    throw new Error("The configured FFmpeg build does not include the libx265 encoder required for HDR HLS.");
  }
  if (!`${stdout}\n${stderr}`.includes("libx264")) {
    throw new Error("The configured FFmpeg build does not include the libx264 encoder required for SDR fallback.");
  }
  return true;
}

async function transcodeRendition(sourcePath, directory, sourceInfo, rendition) {
  const height = Math.min(rendition.height, sourceInfo.height);
  if (height < 360 || height % 2 !== 0) return null;
  const name = `${height}p`;
  const playlistPath = path.join(directory, `${name}.m3u8`);
  const segmentPattern = path.join(directory, `${name}_%05d.m4s`);
  const colorArgs = [
    "-color_primaries", sourceInfo.color_primaries,
    "-color_trc", sourceInfo.color_transfer,
    "-colorspace", sourceInfo.color_space || "bt2020nc",
  ];
  const bitrate = rendition.bitrate;
  await run(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=-2:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-c:v", "libx265", "-preset", process.env.HDR_X265_PRESET || "medium",
    "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate,
    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
    "-x265-params", `hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=${sourceInfo.color_transfer}:colormatrix=${sourceInfo.color_space || "bt2020nc"}`,
    "-map_metadata", "0",
    ...colorArgs,
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", `${name}_init.mp4`,
    "-hls_segment_filename", segmentPattern, playlistPath,
  ]);
  const outputInfo = await execFile(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,level", "-of", "json", playlistPath,
  ], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "{}" }));
  const streamInfo = JSON.parse(outputInfo.stdout).streams?.[0] || {};
  const expectedWidth = Math.max(2, Math.floor((sourceInfo.width * height / sourceInfo.height) / 2) * 2);
  const outputHeight = streamInfo.height || height;
  return { name, height: outputHeight, bitrate, playlistPath, width: streamInfo.width || expectedWidth, level: streamInfo.level };
}

async function uploadDirectory(directory, keyPrefix) {
  const uploaded = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".m3u8" ? "application/vnd.apple.mpegurl" : ext === ".mp4" ? "video/mp4" : "video/iso.segment";
    const key = `${keyPrefix}/${filename}`;
    await uploadFileToR2({ key, filePath: path.join(directory, filename), contentType });
    uploaded.push(key);
  }
  return uploaded;
}

async function saveEarlyPoster(sourcePath, workdir, rawKey, rawMasterUrl, sourceInfo, ownerId) {
  const posterPath = path.join(workdir, "poster.jpg");
  const standardFilter = "scale=960:-2:flags=lanczos";
  const hdrFilter = "zscale=t=linear:npl=100,format=gbrpf32le,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:p=bt709,format=yuv420p," + standardFilter;
  try {
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
      "-map", "0:v:0", "-frames:v", "1", "-vf", sourceInfo.isHdr ? hdrFilter : standardFilter,
      "-q:v", "3", "-map_metadata", "-1", posterPath,
    ]);
    const posterKey = rawKey.replace(/^raw\//, "display/").replace(/\.[^/.]+$/, "-poster.jpg");
    const posterUrl = await uploadFileToR2({ key: posterKey, filePath: posterPath, contentType: "image/jpeg" });
    const rows = await pool.query(
      `UPDATE post_media SET stream_thumbnail_url = COALESCE(stream_thumbnail_url, $1)
       WHERE master_url = $2 RETURNING media_id, post_id`, [posterUrl, rawMasterUrl]
    );
    await cacheHdrResult(rawMasterUrl, { streamThumbnailUrl: posterUrl });
    if (rows.rows.length) await notifyPosterUpdate(rows.rows, ownerId, posterUrl);
  } catch (error) {
    console.warn(`[VideoHdrWorker] Could not make early poster: ${error.message}`);
  }
}

async function notifyPosterUpdate(rows, ownerId, posterUrl) {
  const socketService = require("../core/infrastructure/socket.service");
  const posts = await pool.query("SELECT post_id, visibility, author_id FROM posts WHERE post_id = ANY($1::uuid[])", [[...new Set(rows.map((row) => row.post_id))]]);
  const byId = new Map(posts.rows.map((post) => [post.post_id, post]));
  for (const row of rows) {
    const post = byId.get(row.post_id);
    const payload = { postId: row.post_id, mediaId: row.media_id, media: { media_type: "video", stream_thumbnail_url: posterUrl } };
    if (post?.visibility === "public") socketService.broadcastGlobal?.("media_processing_updated", payload);
    else if (post?.author_id || ownerId) socketService.notifyUser?.(post?.author_id || ownerId, "media_processing_updated", payload);
  }
}

function createMasterPlaylist(variants, transfer) {
  const range = transfer === "arib-std-b67" ? "HLG" : "PQ";
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const variant of variants) {
    const width = variant.width;
    const height = variant.height;
    const bandwidth = Math.round(parseFloat(variant.bitrate) * (variant.bitrate.endsWith("M") ? 1_000_000 : 1_000));
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},VIDEO-RANGE=${range}`);
    lines.push(`${variant.name}.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}

async function processHdrVideo({ rawMasterUrl, rawKey, ownerId }) {
  const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cocpit-hdr-"));
  try {
    const sourcePath = path.join(workdir, "source-video");
    const outputDir = path.join(workdir, "hls");
    await fs.promises.mkdir(outputDir);
    await downloadR2Object(rawKey, sourcePath);
    const sourceInfo = await inspectVideo(sourcePath);
    await saveEarlyPoster(sourcePath, workdir, rawKey, rawMasterUrl, sourceInfo, ownerId);
    if (!sourceInfo.isHdr) {
      await pool.query("UPDATE post_media SET hdr_processing_status = 'not_applicable' WHERE master_url = $1 OR url = $1", [rawMasterUrl]);
      await cacheHdrResult(rawMasterUrl, { hdrProcessingStatus: "not_applicable" });
      return { hdrProcessingStatus: "not_applicable" };
    }

    const variants = [];
    for (const rendition of RENDITIONS.filter((item) => item.height <= sourceInfo.height)) {
      const variant = await transcodeRendition(sourcePath, outputDir, sourceInfo, rendition);
      if (variant) variants.push(variant);
    }
    if (!variants.length) throw new Error("No HDR rendition could be produced for this source resolution.");

    const masterPath = path.join(outputDir, "master.m3u8");
    await fs.promises.writeFile(masterPath, createMasterPlaylist(variants, sourceInfo.color_transfer), "utf8");
    const stableMediaKey = crypto.createHash("sha256").update(rawMasterUrl).digest("hex").slice(0, 32);
    const keyPrefix = `display/videos/${stableMediaKey}/hdr`;
    const objectKeys = await uploadDirectory(outputDir, keyPrefix);
    const masterUrl = getPublicUrl(`${keyPrefix}/master.m3u8`);
    const update = await pool.query(
      `UPDATE post_media SET hdr_manifest_url = $1, hdr_processing_status = 'ready',
         hdr_color_transfer = $2, hdr_width = $3, hdr_height = $4, hdr_error = NULL
       WHERE master_url = $5 OR url = $5 RETURNING media_id, post_id`,
      [masterUrl, sourceInfo.color_transfer, sourceInfo.width, sourceInfo.height, rawMasterUrl]
    );
    await cacheHdrResult(rawMasterUrl, { hdrManifestUrl: masterUrl, hdrProcessingStatus: "ready" });
    await notifyHdrUpdate(update.rows, ownerId, "ready", masterUrl);
    return { hdrManifestUrl: masterUrl, uploadedObjects: objectKeys.length };
  } catch (error) {
    await pool.query(
      `UPDATE post_media SET hdr_processing_status = 'failed', hdr_error = $1 WHERE master_url = $2 OR url = $2`,
      [String(error.message).slice(0, 500), rawMasterUrl]
    ).catch((dbError) => console.error(`[VideoHdrWorker] Could not save HDR failure for ${rawMasterUrl}:`, dbError.message));
    await cacheHdrResult(rawMasterUrl, { hdrProcessingStatus: "failed", hdrError: String(error.message).slice(0, 500) });
    const rows = await pool.query("SELECT media_id, post_id FROM post_media WHERE master_url = $1 OR url = $1", [rawMasterUrl]).catch(() => ({ rows: [] }));
    await notifyHdrUpdate(rows.rows, ownerId, "failed");
    throw error;
  } finally {
    await fs.promises.rm(workdir, { recursive: true, force: true });
  }
}

async function processSdrFallback({ rawMasterUrl, rawKey, ownerId }) {
  const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cocpit-sdr-recovery-"));
  try {
    const sourcePath = path.join(workdir, "source-video");
    const fallbackPath = path.join(workdir, "fallback.mp4");
    await downloadR2Object(rawKey, sourcePath);
    const sourceInfo = await inspectVideo(sourcePath);
    const scale = "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2";
    const toneMap = "zscale=t=linear:npl=100,format=gbrpf32le,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:p=bt709,format=yuv420p,";
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${sourceInfo.isHdr ? toneMap : ""}${scale}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart",
      "-map_metadata", "-1", fallbackPath,
    ]);
    const key = rawKey.replace(/^raw\//, "display/").replace(/\.[^/.]+$/, "-fallback.mp4");
    const fallbackUrl = await uploadFileToR2({ key, filePath: fallbackPath, contentType: "video/mp4" });
    const rows = await pool.query(
      `UPDATE post_media SET fallback_url = $1, url = $1
       WHERE master_url = $2 AND processing_status = 'failed'
       RETURNING media_id, post_id`, [fallbackUrl, rawMasterUrl]
    );
    if (rows.rows.length) {
      await cacheHdrResult(rawMasterUrl, { url: fallbackUrl, fallbackUrl, processingStatus: "failed" });
      await notifyFallbackUpdate(rows.rows, ownerId, fallbackUrl);
    }
    return { fallbackUrl, updated: rows.rowCount };
  } finally {
    await fs.promises.rm(workdir, { recursive: true, force: true });
  }
}

async function notifyFallbackUpdate(rows, ownerId, fallbackUrl) {
  const socketService = require("../core/infrastructure/socket.service");
  const posts = await pool.query("SELECT post_id, visibility, author_id FROM posts WHERE post_id = ANY($1::uuid[])", [[...new Set(rows.map((row) => row.post_id))]]);
  const byId = new Map(posts.rows.map((post) => [post.post_id, post]));
  for (const row of rows) {
    const post = byId.get(row.post_id);
    const payload = { postId: row.post_id, mediaId: row.media_id, processing_status: "failed", media: { media_type: "video", url: fallbackUrl, fallback_url: fallbackUrl } };
    if (post?.visibility === "public") socketService.broadcastGlobal?.("media_processing_updated", payload);
    else if (post?.author_id || ownerId) socketService.notifyUser?.(post?.author_id || ownerId, "media_processing_updated", payload);
  }
}

async function cacheHdrResult(rawMasterUrl, fields) {
  if (!redisClient?.isOpen) return;
  const cacheKey = `media:conversion:${rawMasterUrl}`;
  const current = await redisClient.get(cacheKey);
  const asset = current ? JSON.parse(current) : { url: rawMasterUrl, masterUrl: rawMasterUrl, mediaType: "video" };
  Object.assign(asset, fields);
  await redisClient.set(cacheKey, JSON.stringify(asset), "EX", 30 * 86400);
}

async function notifyHdrUpdate(rows, ownerId, status, hdrManifestUrl = null) {
  if (!rows.length) return;
  const socketService = require("../core/infrastructure/socket.service");
  const postIds = [...new Set(rows.map((row) => row.post_id))];
  const posts = await pool.query("SELECT post_id, visibility, author_id FROM posts WHERE post_id = ANY($1::uuid[])", [postIds]);
  const byId = new Map(posts.rows.map((post) => [post.post_id, post]));
  for (const row of rows) {
    const post = byId.get(row.post_id);
    const payload = {
      postId: row.post_id,
      mediaId: row.media_id,
      hdr_processing_status: status,
      media: { media_type: "video", hdr_manifest_url: hdrManifestUrl, hdr_processing_status: status },
    };
    if (post?.visibility === "public") socketService.broadcastGlobal?.("media_processing_updated", payload);
    else if (post?.author_id || ownerId) socketService.notifyUser?.(post?.author_id || ownerId, "media_processing_updated", payload);
  }
}

let hdrWorker;
function startVideoHdrWorker() {
  if (hdrWorker) return hdrWorker;
  hdrWorker = new Worker("video-hdr-transcode", (job) => job.name === "transcode-sdr-fallback"
    ? processSdrFallback(job.data) : processHdrVideo(job.data), {
    connection: getRedisConnectionOptions(),
    concurrency: Number(process.env.HDR_WORKER_CONCURRENCY || 1),
  });
  hdrWorker.on("completed", (job) => console.log(`[VideoHdrWorker] Job ${job.id} completed.`));
  hdrWorker.on("failed", (job, error) => console.error(`[VideoHdrWorker] Job ${job?.id} failed: ${error.message}`));
  hdrWorker.on("error", (error) => console.error(`[VideoHdrWorker] Worker error: ${error.message}`));
  return hdrWorker;
}

async function closeVideoHdrWorker() {
  if (!hdrWorker) return;
  await hdrWorker.close();
  hdrWorker = null;
}

module.exports = { inspectVideo, processHdrVideo, processSdrFallback, startVideoHdrWorker, closeVideoHdrWorker, createMasterPlaylist, verifyVideoTools };
