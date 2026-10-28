/** Resolve only an authenticated creator's feed original under the configured CDN. */
function ownedPostRawKey(masterUrl, ownerId) {
  if (typeof masterUrl !== "string" || !ownerId) return null;
  const bases = [process.env.R2_PUBLIC_URL, process.env.R2_CDN_BASE_URL]
    .filter(Boolean)
    .map((value) => value.replace(/\/$/, ""));
  for (const base of bases) {
    if (!masterUrl.startsWith(`${base}/`)) continue;
    const key = masterUrl.slice(base.length + 1);
    if (key.startsWith(`raw/posts/${ownerId}-`) || key.startsWith(`raw/posts/${ownerId}/`)) return key;
  }
  return null;
}

module.exports = { ownedPostRawKey };
