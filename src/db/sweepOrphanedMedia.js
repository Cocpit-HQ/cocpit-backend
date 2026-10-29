require('dotenv').config();
const pool = require('../core/db/pool');
const { sweepOrphanedMedia } = require('../workers/mediaOrphanSweeper');

const dryRun = !process.argv.includes('--apply');
sweepOrphanedMedia({ dryRun })
  .then((result) => console.log(`[MediaOrphanSweep] ${dryRun ? 'dry run' : 'apply'}`, result))
  .finally(async () => {
    if (pool.stopHealthCheck) pool.stopHealthCheck();
    await pool.end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
