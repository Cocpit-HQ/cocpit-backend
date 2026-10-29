require('dotenv').config();
const crypto = require('crypto');
const pool = require('../core/db/pool');
const { ownedPostRawKey } = require('../core/infrastructure/postMediaKey');

async function enqueueExistingImageVariants({ apply = false, limit = 500 } = {}) {
  if (!process.env.R2_PUBLIC_URL && !process.env.R2_CDN_BASE_URL) throw new Error('Set R2_PUBLIC_URL or R2_CDN_BASE_URL before scanning existing images.');
  if (apply && !process.env.REDIS_URL) throw new Error('Set REDIS_URL to the shared queue Redis instance.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Limit must be an integer between 1 and 10000.');
  const { rows } = await pool.query(
    `SELECT pm.media_id, pm.master_url, p.post_id,
            COALESCE(p.author_id, p.author_org_id)::text AS owner_id
       FROM post_media pm JOIN posts p ON p.post_id = pm.post_id
      WHERE pm.media_type = 'image' AND pm.processing_status = 'ready'
        AND pm.master_url IS NOT NULL AND pm.variants = '{}'::jsonb
        AND p.is_active = TRUE
      ORDER BY pm.media_id LIMIT $1`, [limit]
  );
  const eligible = rows.map((row) => ({ ...row, rawKey: ownedPostRawKey(row.master_url, row.owner_id) }))
    .filter((row) => row.rawKey);
  let queued = 0;
  let skipped = 0;
  if (apply) {
    const { mediaTranscodeQueue, addTranscodeJob } = require('../queues/media.queue');
    for (const row of eligible) {
      const stableId = crypto.createHash('sha256').update(row.rawKey).digest('hex').slice(0, 32);
      const existing = await mediaTranscodeQueue.getJob(`transcode-${stableId}`);
      if (existing) {
        const state = await existing.getState();
        if (['active', 'waiting', 'delayed'].includes(state)) { skipped++; continue; }
        await existing.remove();
      }
      await addTranscodeJob({ rawKey: row.rawKey, rawMasterUrl: row.master_url,
        mediaType: 'image', postId: row.post_id, ownerId: row.owner_id });
      queued++;
    }
  }
  return { scanned: rows.length, eligible: eligible.length, queued, skipped, dryRun: !apply };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 500;
  enqueueExistingImageVariants({ apply, limit })
    .then((result) => console.log('[ImageVariantBackfill]', result))
    .catch((error) => { console.error('[ImageVariantBackfill]', error.message); process.exitCode = 1; })
    .finally(async () => {
      if (pool.stopHealthCheck) pool.stopHealthCheck();
      await pool.end().catch(() => {});
      if (apply) await require('../queues/media.queue').mediaTranscodeQueue.close().catch(() => {});
      process.exit(process.exitCode || 0);
    });
}

module.exports = { enqueueExistingImageVariants };
