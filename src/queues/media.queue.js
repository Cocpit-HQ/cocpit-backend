const { Queue } = require("bullmq");

const redisConnection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  maxRetriesPerRequest: null,
};

const mediaTranscodeQueue = new Queue("media-transcode", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

mediaTranscodeQueue.on("error", (err) => {
  console.error("[MediaQueue] Queue error:", err.message);
});

/**
 * Enqueue a media transcoding job.
 * @param {object} payload
 * @param {string} payload.rawKey       - R2 key of raw file
 * @param {string} payload.rawMasterUrl - Public URL of raw file
 * @param {string} [payload.mediaType]  - "image" | "video"
 * @param {string} [payload.postId]     - Optional associated post_id
 * @returns {Promise<import("bullmq").Job>}
 */
async function addTranscodeJob({ rawKey, rawMasterUrl, mediaType = "image", postId = null }) {
  const job = await mediaTranscodeQueue.add(
    "transcode",
    { rawKey, rawMasterUrl, mediaType, postId },
    {
      jobId: `transcode-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    }
  );
  console.log(`[MediaQueue] Enqueued job ${job.id} for rawKey: ${rawKey}`);
  return job;
}

/**
 * Get the status of an ongoing or completed transcode job.
 * @param {string} jobId
 */
async function getJobStatus(jobId) {
  const job = await mediaTranscodeQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    id: job.id,
    state,
    progress: job.progress,
    data: job.data,
    returnvalue: job.returnvalue || null,
    failedReason: job.failedReason || null,
  };
}

module.exports = {
  mediaTranscodeQueue,
  addTranscodeJob,
  getJobStatus,
  redisConnection,
};
