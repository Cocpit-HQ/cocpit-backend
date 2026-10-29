const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

if (!process.env.REDIS_URL) {
  throw new Error("The isolated media worker requires REDIS_URL pointing to shared Redis.");
}

const pool = require("./core/db/pool");
const { startMediaTranscoderWorker } = require("./workers/mediaTranscoder.worker");
const { sweepOrphanedMedia } = require("./workers/mediaOrphanSweeper");

startMediaTranscoderWorker();

const sweep = () => {
  const dryRun = process.env.MEDIA_ORPHAN_SWEEP_APPLY !== "true";
  void sweepOrphanedMedia({ dryRun }).then((result) => {
    console.log(`[MediaWorker] Orphan sweep (${dryRun ? "dry run" : "apply"}): ${JSON.stringify(result)}`);
  }).catch((error) => console.error("[MediaWorker] Orphan sweep failed:", error));
};
const firstSweep = setTimeout(sweep, 10 * 60 * 1000);
const weeklySweep = setInterval(sweep, 7 * 24 * 60 * 60 * 1000);
firstSweep.unref?.();
weeklySweep.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(firstSweep);
  clearInterval(weeklySweep);
  console.log(`[MediaWorker] Received ${signal}; closing workers.`);
  await Promise.allSettled([
    require("./workers/mediaTranscoder.worker").closeMediaTranscoderWorker?.(),
  ]);
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
