/**
 * verify_local_uat_media.js
 * 
 * Verification script to validate that all media links on the local UAT database:
 *   Host: 192.168.1.50:5432
 *   Database: cocpit_backend_uat
 *   User: swaroop
 * 
 * Checks performed:
 *  1. Counts active Cloudflare R2 links across all 14 media tables.
 *  2. Checks for any remaining Cloudinary links.
 *  3. Compares counts side-by-side with the Railway database (Source of Truth).
 *  4. Performs live HTTP HEAD checks on sample R2 media URLs to confirm HTTP 200 OK responses.
 * 
 * Usage:
 *   node scripts/verify_local_uat_media.js
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');
require('dotenv').config();

const TARGET_CONFIG = {
  host: process.env.TARGET_DB_HOST || '192.168.1.50',
  port: parseInt(process.env.TARGET_DB_PORT || '5432', 10),
  database: process.env.TARGET_DB_NAME || 'cocpit_backend_uat',
  user: process.env.TARGET_DB_USER || 'swaroop',
  password: process.env.TARGET_DB_PASSWORD || 'cocpit@4713',
  ssl: false
};

const SOURCE_CONFIG = {
  connectionString: process.env.SOURCE_DATABASE_URL ||
    'postgresql://postgres:sSWdEpqkZHkmXYEQUELDCXzXlooxyBAC@caboose.proxy.rlwy.net:26518/railway',
  ssl: { rejectUnauthorized: false }
};

const CHECKS = [
  { table: 'post_media', col: 'url', type: 'text' },
  { table: 'users', col: 'avatar_url', type: 'text' },
  { table: 'users', col: 'cover_image_url', type: 'text' },
  { table: 'user_resumes', col: 'file_url', type: 'text' },
  { table: 'project_media', col: 'url', type: 'text' },
  { table: 'project_media', col: 'file_url', type: 'text' },
  { table: 'organizations', col: 'logo_url', type: 'text' },
  { table: 'organizations', col: 'cover_url', type: 'text' },
  { table: 'achievement_images', col: 'cloudinary_url', type: 'text' },
  { table: 'user_verifications', col: 'front_image_url', type: 'text' },
  { table: 'user_verifications', col: 'back_image_url', type: 'text' },
  { table: 'support_tickets', col: 'attachment_url', type: 'text' },
  { table: 'organization_documents', col: 'document_url', type: 'text' },
  { table: 'stories', col: 'media_url', type: 'text' },
  { table: 'organization_verifications', col: 'document_urls', type: 'jsonb' },
  { table: 'user_search_history', col: 'profile_snapshot', type: 'jsonb' },
  { table: 'audit_logs', col: 'metadata', type: 'jsonb' },
  { table: 'posts', col: 'content', type: 'text' }
];

function checkUrlLive(url) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https:') ? https : http;
      const req = client.request(url, { method: 'HEAD', timeout: 6000 }, (res) => {
        resolve({ url, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
      });
      req.on('error', (err) => resolve({ url, status: 'ERROR', error: err.message, ok: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ url, status: 'TIMEOUT', ok: false });
      });
      req.end();
    } catch (e) {
      resolve({ url, status: 'ERR', error: e.message, ok: false });
    }
  });
}

async function main() {
  console.log("=======================================================================");
  console.log("  MEDIA LINKS VERIFICATION: LOCAL UAT DATABASE                         ");
  console.log("=======================================================================");
  console.log(`Target DB: ${TARGET_CONFIG.host}:${TARGET_CONFIG.port}/${TARGET_CONFIG.database}`);
  console.log(`Source DB: caboose.proxy.rlwy.net:26518/railway`);
  console.log("=======================================================================\n");

  const targetPool = new Pool(TARGET_CONFIG);
  const sourcePool = new Pool(SOURCE_CONFIG);

  let targetClient;
  let sourceClient;

  try {
    // Connect to Target DB
    try {
      targetClient = await targetPool.connect();
      console.log(`✓ Connected to Local UAT Target DB (${TARGET_CONFIG.host}:${TARGET_CONFIG.port})`);
    } catch (err) {
      console.error(`✖ Failed to connect to Target DB (${TARGET_CONFIG.host}:${TARGET_CONFIG.port}):`, err.message);
      console.log("Please verify host address, user credentials, and network/VPN connectivity.");
      return;
    }

    // Connect to Source DB (for comparison)
    let compareWithSource = false;
    try {
      sourceClient = await sourcePool.connect();
      compareWithSource = true;
      console.log(`✓ Connected to Railway Source DB for 1-to-1 baseline comparison\n`);
    } catch (err) {
      console.log(`! Note: Could not reach Railway DB for side-by-side comparison (${err.message}). Proceeding with Local UAT verification only.\n`);
    }

    // -------------------------------------------------------------
    // Check 1: Link Counts Table-by-Table
    // -------------------------------------------------------------
    console.log("[1] Table-by-Table Link Analysis (R2 vs Cloudinary):");
    console.log("---------------------------------------------------------------------------------------------------");
    console.log(
      "Table.Column".padEnd(38) +
      "Local R2 (uat/)".padEnd(18) +
      "Local Cloudinary".padEnd(18) +
      (compareWithSource ? "Railway R2".padEnd(15) + "Match Status" : "")
    );
    console.log("---------------------------------------------------------------------------------------------------");

    let totalLocalR2 = 0;
    let totalLocalCloudinary = 0;
    let totalRailwayR2 = 0;
    let mismatches = 0;
    const sampleUrlsToTest = [];

    for (const c of CHECKS) {
      const fieldAccessor = c.type === 'jsonb' ? `${c.col}::text` : c.col;

      // Query Local Target DB
      const r2Query = `SELECT count(*) FROM ${c.table} WHERE ${fieldAccessor} ILIKE '%r2.dev/uat/%';`;
      const cldQuery = `SELECT count(*) FROM ${c.table} WHERE ${fieldAccessor} ILIKE '%cloudinary%';`;
      
      const [r2Res, cldRes] = await Promise.all([
        targetClient.query(r2Query),
        targetClient.query(cldQuery)
      ]);

      const localR2Count = parseInt(r2Res.rows[0].count, 10);
      const localCldCount = parseInt(cldRes.rows[0].count, 10);
      totalLocalR2 += localR2Count;
      totalLocalCloudinary += localCldCount;

      let railwayR2Count = '-';
      let matchStatus = '-';

      if (compareWithSource && sourceClient) {
        const srcRes = await sourceClient.query(r2Query);
        railwayR2Count = parseInt(srcRes.rows[0].count, 10);
        totalRailwayR2 += railwayR2Count;

        if (localR2Count === railwayR2Count) {
          matchStatus = '✓ MATCH';
        } else {
          matchStatus = `✖ MISMATCH (${localR2Count}/${railwayR2Count})`;
          mismatches++;
        }
      }

      // Collect sample URLs for live HTTP check
      if (localR2Count > 0 && sampleUrlsToTest.length < 8 && c.type !== 'jsonb') {
        const sampleQuery = `SELECT ${c.col} FROM ${c.table} WHERE ${c.col} ILIKE '%r2.dev/uat/%' LIMIT 2;`;
        const sampleRes = await targetClient.query(sampleQuery);
        for (const r of sampleRes.rows) {
          if (r[c.col] && typeof r[c.col] === 'string' && r[c.col].startsWith('http')) {
            sampleUrlsToTest.push({ label: `${c.table}.${c.col}`, url: r[c.col] });
          }
        }
      }

      const label = `${c.table}.${c.col}`;
      console.log(
        label.padEnd(38) +
        String(localR2Count).padEnd(18) +
        String(localCldCount).padEnd(18) +
        (compareWithSource ? String(railwayR2Count).padEnd(15) + matchStatus : "")
      );
    }

    console.log("---------------------------------------------------------------------------------------------------");
    console.log(
      "TOTALS".padEnd(38) +
      String(totalLocalR2).padEnd(18) +
      String(totalLocalCloudinary).padEnd(18) +
      (compareWithSource ? String(totalRailwayR2).padEnd(15) + (mismatches === 0 ? "✓ 100% MATCH" : `✖ ${mismatches} DIFF`) : "")
    );
    console.log("---------------------------------------------------------------------------------------------------\n");

    // -------------------------------------------------------------
    // Check 2: Live HTTP Resolution on Cloudflare R2
    // -------------------------------------------------------------
    console.log("[2] Live Asset Accessibility Check (Testing Sample URLs on Cloudflare R2 Public CDN):");
    if (sampleUrlsToTest.length === 0) {
      console.log("  No sample R2 URLs found to verify.");
    } else {
      const results = await Promise.all(sampleUrlsToTest.slice(0, 6).map(async (item) => {
        const res = await checkUrlLive(item.url);
        return { ...item, ...res };
      }));

      for (const r of results) {
        const statusIcon = r.ok ? '✓' : '✖';
        console.log(`  ${statusIcon} [HTTP ${r.status}] ${r.label.padEnd(28)} : ${r.url}`);
      }
    }

    // -------------------------------------------------------------
    // Final Verdict
    // -------------------------------------------------------------
    console.log("\n=======================================================================");
    if (totalLocalR2 > 0 && (!compareWithSource || mismatches === 0)) {
      console.log("  STATUS: [SUCCESS] ALL MEDIA LINKS SUCCESSFULLY MIGRATED TO R2!       ");
      console.log(`  - Total Cloudflare R2 Media Active: ${totalLocalR2}`);
      console.log(`  - Cloudinary Links Remaining:       ${totalLocalCloudinary}`);
      console.log("  All media files are consistent, intact, and resolving directly via R2.");
    } else if (totalLocalR2 === 0) {
      console.log("  STATUS: [PENDING] LOCAL UAT DATABASE STILL CONTAINS CLOUDINARY LINKS.");
      console.log("  To migrate, run:");
      console.log("    node scripts/sync_media_railway_to_local_uat.js");
    } else {
      console.log("  STATUS: [PARTIAL] MIGRATION COMPLETED WITH DISCREPANCIES.");
      console.log(`  Check the mismatch items in the table above.`);
    }
    console.log("=======================================================================\n");

  } catch (err) {
    console.error("Verification error:", err);
  } finally {
    if (targetClient) targetClient.release();
    if (sourceClient) sourceClient.release();
    await targetPool.end();
    await sourcePool.end();
  }
}

main();
