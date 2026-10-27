require("dotenv").config();
const pool = require("../core/db/pool");
const { addTranscodeJob } = require("../queues/media.queue");

function getRawKeyFromUrl(rawUrl) {
  const base = (process.env.R2_PUBLIC_URL || process.env.R2_CDN_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Set R2_PUBLIC_URL or R2_CDN_BASE_URL before scanning existing videos.");
  const mediaUrl = new URL(rawUrl);
  const publicUrl = new URL(base);
  if (mediaUrl.origin !== publicUrl.origin || !mediaUrl.pathname.startsWith(`${publicUrl.pathname.replace(/\/$/, "")}/`)) return null;
  const key = decodeURIComponent(mediaUrl.pathname.slice(publicUrl.pathname.replace(/\/$/, "").length).replace(/^\//, ""));
  return key.startsWith("raw/") ? key : null;
}

async function main() {
  if (!process.env.REDIS_URL) throw new Error("Set REDIS_URL to the shared queue Redis instance.");
  const apply = process.argv.includes("--apply");
  const { rows } = await pool.query(
    `SELECT pm.media_id, pm.url, pm.master_url,
            COALESCE(p.author_id, p.author_org_id)::text AS creator_id
       FROM post_media pm
       JOIN posts p ON p.post_id = pm.post_id
      WHERE pm.media_type = 'video'
        AND pm.stream_uid IS NULL
      ORDER BY pm.media_id`
  );
  const eligible = rows.flatMap((row) => {
    const rawMasterUrl = row.master_url || row.url;
    const rawKey = getRawKeyFromUrl(rawMasterUrl);
    return rawKey ? [{ ...row, rawMasterUrl, rawKey }] : [];
  });

  console.log(`[ExistingVideoQueue] ${eligible.length}/${rows.length} videos have an R2 raw master${apply ? "; queueing" : "; dry run only"}.`);
  if (apply) {
    for (const item of eligible) {
      await addTranscodeJob({ rawKey: item.rawKey, rawMasterUrl: item.rawMasterUrl, mediaType: "video", ownerId: item.creator_id });
      await pool.query(
        `UPDATE post_media SET processing_status = 'processing', processing_error = NULL, is_processed = FALSE
          WHERE media_id = $1 AND stream_uid IS NULL`,
        [item.media_id]
      );
    }
    console.log(`[ExistingVideoQueue] Queued ${eligible.length} videos.`);
  }
}

main()
  .catch((error) => {
    console.error(`[ExistingVideoQueue] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    await require("../queues/media.queue").mediaTranscodeQueue.close().catch(() => {});
  });
