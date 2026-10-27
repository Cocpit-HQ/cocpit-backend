const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

if (!process.env.REDIS_URL) {
  throw new Error("The isolated media worker requires REDIS_URL pointing to shared Redis.");
}

const pool = require("./core/db/pool");
const { startMediaTranscoderWorker } = require("./workers/mediaTranscoder.worker");

startMediaTranscoderWorker();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[MediaWorker] Received ${signal}; closing workers.`);
  await Promise.allSettled([
    require("./workers/mediaTranscoder.worker").closeMediaTranscoderWorker?.(),
  ]);
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
