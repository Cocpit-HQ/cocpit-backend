const crypto = require("crypto");
const { deleteMediaByUrls, deleteR2Prefix } = require("./r2.client");
const { deleteStreamVideo, isStreamConfigured } = require("./cloudflareStream.client");
const redisClient = require("../cache/redis");

async function deleteHybridMedia(records) {
  const items = (Array.isArray(records) ? records : [records]).filter(Boolean);
  const tasks = [];
  const r2Items = items.flatMap((item) => [item.master_url, item.masterUrl, item.url].filter(Boolean));
  if (r2Items.length) tasks.push(deleteMediaByUrls(r2Items));
  for (const item of items) {
    const masterUrl = item.master_url || item.masterUrl || item.url;
    if (masterUrl) {
      const stableMediaKey = crypto.createHash("sha256").update(masterUrl).digest("hex").slice(0, 32);
      tasks.push(deleteR2Prefix(`display/videos/${stableMediaKey}/hdr`));
    }
    const streamUid = item.stream_uid || item.streamUid;
    if (streamUid && !isStreamConfigured()) {
      tasks.push(Promise.reject(new Error(`Cannot delete Stream video ${streamUid}: Stream API credentials are not configured.`)));
    } else if (streamUid) tasks.push(deleteStreamVideo(streamUid));
    if (masterUrl && redisClient?.status === "ready") tasks.push(redisClient.del(`media:conversion:${masterUrl}`));
    if (streamUid && redisClient?.status === "ready") tasks.push(redisClient.del(`media:stream:uid:${streamUid}`));
  }
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map((failure) => failure.reason), `Failed to clean up ${failures.length} media asset(s).`);
  }
}

module.exports = { deleteHybridMedia };
