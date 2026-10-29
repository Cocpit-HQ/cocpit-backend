const { Queue } = require("bullmq");
const { getRedisConnectionOptions } = require("./media.queue");

const videoHdrQueue = new Queue("video-hdr-transcode", {
  connection: getRedisConnectionOptions(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});

async function addVideoHdrJob({ rawMasterUrl, rawKey, ownerId, postId }) {
  const id = require("crypto").createHash("sha256").update(rawMasterUrl).digest("hex").slice(0, 32);
  return videoHdrQueue.add("transcode-hdr", { rawMasterUrl, rawKey, ownerId, postId }, {
    jobId: `video-hdr-${id}`,
  });
}

async function addVideoFallbackJob({ rawMasterUrl, rawKey, ownerId, postId }) {
  const id = require("crypto").createHash("sha256").update(rawMasterUrl).digest("hex").slice(0, 32);
  return videoHdrQueue.add("transcode-sdr-fallback", { rawMasterUrl, rawKey, ownerId, postId }, {
    jobId: `video-fallback-${id}`,
  });
}

module.exports = { videoHdrQueue, addVideoHdrJob, addVideoFallbackJob };
