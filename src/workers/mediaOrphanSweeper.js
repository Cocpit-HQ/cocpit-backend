const pool = require('../core/db/pool');
const { deleteObjectsFromR2, listR2Objects } = require('../core/infrastructure/r2.client');

const SAFE_PREFIXES = ['raw/posts/', 'display/posts/', 'display/videos/', 'avatars/', 'covers/', 'resumes/'];
const GRACE_MS = 24 * 60 * 60 * 1000;
const LOCK_ID = '640715284719';

function ownedKey(value) {
  if (typeof value !== 'string') return null;
  if (SAFE_PREFIXES.some((prefix) => value.startsWith(prefix))) return value;
  for (const base of [process.env.R2_PUBLIC_URL, process.env.R2_CDN_BASE_URL].filter(Boolean)) {
    const normalized = base.replace(/\/$/, '');
    if (!value.startsWith(`${normalized}/`)) continue;
    const key = value.slice(normalized.length + 1);
    if (SAFE_PREFIXES.some((prefix) => key.startsWith(prefix))) return key;
  }
  return null;
}

function referencedKeys(rows) {
  const keys = new Set();
  const add = (value) => {
    const key = ownedKey(value);
    if (key) keys.add(key);
  };
  for (const row of rows) {
    for (const field of ['master_url', 'url', 'fallback_url', 'avif_url', 'stream_thumbnail_url', 'hdr_manifest_url', 'avatar_url', 'cover_image_url', 'file_url', 'resume_url']) add(row[field]);
    for (const format of ['fallback', 'avif']) {
      for (const variant of row.variants?.[format] || []) add(variant.url);
    }
  }
  return keys;
}

async function sweepOrphanedMedia({ now = new Date(), dryRun = false } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [LOCK_ID]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { skipped: true, deleted: 0 };

    // A failed reference query must abort the sweep before any deletion.
    const media = await client.query('SELECT master_url, url, fallback_url, avif_url, stream_thumbnail_url, hdr_manifest_url, variants FROM post_media');
    const users = await client.query('SELECT avatar_url, cover_image_url FROM users');
    const resumes = await client.query('SELECT file_url FROM user_resumes');
    const applications = await client.query('SELECT resume_url FROM job_applications WHERE resume_url IS NOT NULL');
    const projects = await client.query('SELECT url, file_url FROM project_media WHERE url IS NOT NULL OR file_url IS NOT NULL');
    const active = referencedKeys([...media.rows, ...users.rows, ...resumes.rows, ...applications.rows, ...projects.rows]);
    const activeHdrPrefixes = media.rows.map((row) => ownedKey(row.hdr_manifest_url))
      .filter((key) => key?.startsWith('display/videos/') && key.endsWith('/master.m3u8'))
      .map((key) => key.slice(0, -'master.m3u8'.length));
    const cutoff = now.getTime() - GRACE_MS;
    const orphans = [];
    for (const prefix of SAFE_PREFIXES) {
      let token;
      do {
        const page = await listR2Objects(prefix, token);
        for (const item of page.Contents || []) {
          if (item.Key && item.LastModified && new Date(item.LastModified).getTime() < cutoff
              && !active.has(item.Key) && !activeHdrPrefixes.some((activePrefix) => item.Key.startsWith(activePrefix))) {
            orphans.push(item.Key);
          }
        }
        if (page.IsTruncated && !page.NextContinuationToken) throw new Error(`R2 listing for ${prefix} was truncated without a continuation token.`);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    }
    if (!dryRun && orphans.length) await deleteObjectsFromR2(orphans);
    return { skipped: false, deleted: dryRun ? 0 : orphans.length, candidates: orphans.length };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

module.exports = { sweepOrphanedMedia, ownedKey, referencedKeys, SAFE_PREFIXES };
