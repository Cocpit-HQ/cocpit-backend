const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

if (!process.env.REDIS_URL) {
  throw new Error("The isolated HDR worker requires REDIS_URL pointing to shared Redis.");
}

const pool = require("./core/db/pool");
const { startVideoHdrWorker, closeVideoHdrWorker, verifyVideoTools } = require("./workers/videoHdr.worker");

verifyVideoTools().catch((error) => {
  console.error(`[VideoHdrWorker] Required video tools are unavailable: ${error.message}`);
  process.exit(1);
});
startVideoHdrWorker();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[VideoHdrWorker] Received ${signal}; closing worker.`);
  await closeVideoHdrWorker().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
