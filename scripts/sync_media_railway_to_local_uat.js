/**
 * sync_media_railway_to_local_uat.js
 * 
 * Synchronizes all media file links (Cloudflare R2 links with /uat/ prefix)
 * from the Railway Cloud database to the Local Network UAT database:
 *   Host: 192.168.1.50:5432
 *   Database: cocpit_backend_uat
 *   User: swaroop
 * 
 * Features:
 *  - Primary-Key matching: Directly updates rows by primary key to ensure 100% precision.
 *  - Atomic transaction: Uses BEGIN / COMMIT. Auto-rollback on any error.
 *  - Backup & Reversibility: Captures original values before update into a JSON backup file.
 *  - Standalone SQL Generation: Automatically writes 'sync_media_to_local_uat.sql' for manual psql execution.
 *  - Dry-Run Support: Test without applying changes using `--dry-run`.
 * 
 * Usage:
 *   node scripts/sync_media_railway_to_local_uat.js              # Live execution with atomic transaction
 *   node scripts/sync_media_railway_to_local_uat.js --dry-run    # Preview changes only (no DB writes)
 *   node scripts/sync_media_railway_to_local_uat.js --sql-only   # Generate SQL script only without connecting to target
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ==========================================
// 1. DATABASE CONFIGURATION
// ==========================================
const SOURCE_CONFIG = {
  connectionString: process.env.SOURCE_DATABASE_URL ||
    'postgresql://postgres:sSWdEpqkZHkmXYEQUELDCXzXlooxyBAC@caboose.proxy.rlwy.net:26518/railway',
  ssl: { rejectUnauthorized: false }
};

const TARGET_CONFIG = {
  host: process.env.TARGET_DB_HOST || '192.168.1.50',
  port: parseInt(process.env.TARGET_DB_PORT || '5432', 10),
  database: process.env.TARGET_DB_NAME || 'cocpit_backend_uat',
  user: process.env.TARGET_DB_USER || 'swaroop',
  password: process.env.TARGET_DB_PASSWORD || 'cocpit@4713',
  ssl: false
};

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isSqlOnly = args.includes('--sql-only');

// ==========================================
// 2. TABLE SPECIFICATIONS
// ==========================================
// Lists all tables containing media URLs, their primary keys, and media columns
const TABLE_SPECS = [
  {
    table: 'post_media',
    pk: 'media_id',
    columns: ['url'],
    type: 'standard'
  },
  {
    table: 'users',
    pk: 'user_id',
    columns: ['avatar_url', 'cover_image_url'],
    type: 'standard'
  },
  {
    table: 'user_resumes',
    pk: 'resume_id',
    columns: ['file_url'],
    type: 'standard'
  },
  {
    table: 'project_media',
    pk: 'media_id',
    columns: ['url', 'file_url'],
    type: 'standard'
  },
  {
    table: 'organizations',
    pk: 'org_id',
    columns: ['logo_url', 'cover_url'],
    type: 'standard'
  },
  {
    table: 'achievement_images',
    pk: 'id',
    columns: ['cloudinary_url'],
    type: 'standard'
  },
  {
    table: 'user_verifications',
    pk: 'verification_id',
    columns: ['front_image_url', 'back_image_url'],
    type: 'standard'
  },
  {
    table: 'support_tickets',
    pk: 'ticket_id',
    columns: ['attachment_url'],
    type: 'standard'
  },
  {
    table: 'organization_documents',
    pk: 'document_id',
    columns: ['document_url'],
    type: 'standard'
  },
  {
    table: 'stories',
    pk: 'story_id',
    columns: ['media_url'],
    type: 'standard'
  },
  {
    table: 'organization_verifications',
    pk: 'verification_id',
    columns: ['document_urls'],
    type: 'jsonb'
  },
  {
    table: 'user_search_history',
    pk: 'id',
    columns: ['profile_snapshot'],
    type: 'jsonb'
  },
  {
    table: 'audit_logs',
    pk: 'log_id',
    columns: ['metadata'],
    type: 'jsonb'
  },
  {
    table: 'posts',
    pk: 'post_id',
    columns: ['content'],
    type: 'text'
  }
];

// Helper to escape SQL single quotes
function escapeSql(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function main() {
  console.log("=======================================================================");
  console.log("  MEDIA LINKS SYNCHRONIZATION: RAILWAY -> LOCAL UAT DATABASE           ");
  console.log("=======================================================================");
  console.log(`Source DB (Railway):   caboose.proxy.rlwy.net:26518/railway`);
  console.log(`Target DB (Local UAT): ${TARGET_CONFIG.host}:${TARGET_CONFIG.port}/${TARGET_CONFIG.database}`);
  console.log(`Target User:           ${TARGET_CONFIG.user}`);
  console.log(`Mode:                  ${isDryRun ? 'DRY-RUN (Simulation Only)' : isSqlOnly ? 'SQL-ONLY (No DB Updates)' : 'LIVE EXECUTION (Atomic Transaction)'}`);
  console.log("=======================================================================\n");

  const sourcePool = new Pool(SOURCE_CONFIG);
  let targetPool = null;

  try {
    // -------------------------------------------------------------
    // Step 1: Connect to Source DB & Extract Updated Media Records
    // -------------------------------------------------------------
    console.log("[Step 1] Connecting to Railway Database...");
    const sourceClient = await sourcePool.connect();
    console.log("✓ Connected to Railway Database successfully.\n");

    console.log("[Step 2] Extracting Cloudflare R2 media links from Railway...");
    const tableData = {};
    let totalR2Records = 0;
    const urlMap = new Map(); // Map from old Cloudinary / root URLs to new R2 URLs

    for (const spec of TABLE_SPECS) {
      const colList = [spec.pk, ...spec.columns].join(', ');
      
      // Select rows where any media column contains 'r2.dev'
      const conditions = spec.columns.map(c => {
        if (spec.type === 'jsonb') {
          return `${c}::text ILIKE '%r2.dev%'`;
        }
        return `${c} ILIKE '%r2.dev%'`;
      }).join(' OR ');

      const query = `SELECT ${colList} FROM ${spec.table} WHERE ${conditions};`;
      const res = await sourceClient.query(query);
      tableData[spec.table] = res.rows;
      totalR2Records += res.rows.length;

      console.log(`  - ${spec.table.padEnd(28)} : ${String(res.rows.length).padStart(4)} records with R2 links`);
    }

    sourceClient.release();
    console.log(`\nTotal updated media records retrieved from Railway: ${totalR2Records}\n`);

    if (totalR2Records === 0) {
      console.log("⚠ No R2 links found in Railway database. Migration aborted.");
      return;
    }

    // -------------------------------------------------------------
    // Step 3: Build SQL Migration Statements
    // -------------------------------------------------------------
    console.log("[Step 3] Generating SQL update statements for Target DB...");
    const sqlStatements = [];
    sqlStatements.push("-- =====================================================================");
    sqlStatements.push("-- Cocpit Media Synchronization: Railway -> Local UAT Database");
    sqlStatements.push(`-- Generated: ${new Date().toISOString()}`);
    sqlStatements.push("-- Target: " + TARGET_CONFIG.host + ":" + TARGET_CONFIG.port + "/" + TARGET_CONFIG.database);
    sqlStatements.push("-- =====================================================================\n");
    sqlStatements.push("BEGIN;\n");

    for (const spec of TABLE_SPECS) {
      const rows = tableData[spec.table] || [];
      if (rows.length === 0) continue;

      sqlStatements.push(`-- Table: ${spec.table} (${rows.length} records)`);
      for (const row of rows) {
        const pkVal = row[spec.pk];
        const setClauses = [];

        for (const col of spec.columns) {
          const val = row[col];
          if (val === null || val === undefined) continue;

          if (spec.type === 'jsonb') {
            setClauses.push(`${col} = ${escapeSql(JSON.stringify(val))}::jsonb`);
          } else {
            setClauses.push(`${col} = ${escapeSql(val)}`);
          }
        }

        if (setClauses.length > 0) {
          const stmt = `UPDATE ${spec.table} SET ${setClauses.join(', ')} WHERE ${spec.pk} = ${escapeSql(pkVal)};`;
          sqlStatements.push(stmt);
        }
      }
      sqlStatements.push(""); // empty line
    }

    sqlStatements.push("COMMIT;\n");

    const sqlFilePath = path.join(__dirname, 'sync_media_to_local_uat.sql');
    fs.writeFileSync(sqlFilePath, sqlStatements.join('\n'), 'utf8');
    console.log(`✓ Standalone SQL migration script generated at:`);
    console.log(`  ${sqlFilePath}\n`);

    if (isSqlOnly) {
      console.log("SQL script generated successfully. Exiting as --sql-only was specified.");
      return;
    }

    // -------------------------------------------------------------
    // Step 4: Connect to Target DB & Apply Updates
    // -------------------------------------------------------------
    console.log(`[Step 4] Connecting to Target Database (${TARGET_CONFIG.host}:${TARGET_CONFIG.port}/${TARGET_CONFIG.database})...`);
    targetPool = new Pool(TARGET_CONFIG);
    
    let targetClient;
    try {
      targetClient = await targetPool.connect();
      console.log("✓ Connected to Target Database successfully.\n");
    } catch (connErr) {
      console.error(`\n✖ Could not connect to Target DB (${TARGET_CONFIG.host}:${TARGET_CONFIG.port}): ${connErr.message}`);
      console.log(`\nTIP: Ensure you are on the same local network / VPN as ${TARGET_CONFIG.host}.`);
      console.log(`Alternatively, you can apply the generated SQL file directly on that machine:`);
      console.log(`  psql -h ${TARGET_CONFIG.host} -U ${TARGET_CONFIG.user} -d ${TARGET_CONFIG.database} -f "${sqlFilePath}"`);
      return;
    }

    // -------------------------------------------------------------
    // Step 5: Backup Existing Values before updating
    // -------------------------------------------------------------
    console.log("[Step 5] Backing up current target records prior to modification...");
    const backupData = {};
    for (const spec of TABLE_SPECS) {
      const rows = tableData[spec.table] || [];
      if (rows.length === 0) continue;

      const pks = rows.map(r => r[spec.pk]);
      const colList = [spec.pk, ...spec.columns].join(', ');
      
      const res = await targetClient.query(
        `SELECT ${colList} FROM ${spec.table} WHERE ${spec.pk} = ANY($1::${spec.pk === 'id' ? 'int[]' : 'uuid[]'});`,
        [pks]
      );
      backupData[spec.table] = res.rows;
    }

    const backupFilePath = path.join(__dirname, `media_sync_backup_${Date.now()}.json`);
    fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf8');
    console.log(`✓ Target pre-migration backup saved to:`);
    console.log(`  ${backupFilePath}\n`);

    // -------------------------------------------------------------
    // Step 6: Execute Updates inside Transaction
    // -------------------------------------------------------------
    if (isDryRun) {
      console.log("=======================================================================");
      console.log("  [DRY-RUN COMPLETE] No database modifications were written.           ");
      console.log(`  To apply these changes, run without --dry-run:                      `);
      console.log(`    node scripts/sync_media_railway_to_local_uat.js                    `);
      console.log("=======================================================================");
      targetClient.release();
      return;
    }

    console.log("[Step 6] Applying media updates inside an atomic transaction (BEGIN)...");
    await targetClient.query("BEGIN;");

    const stats = {};
    let totalUpdatedRows = 0;

    for (const spec of TABLE_SPECS) {
      const rows = tableData[spec.table] || [];
      stats[spec.table] = 0;

      for (const row of rows) {
        const pkVal = row[spec.pk];
        
        // Parameterized update query for safety
        const setParts = [];
        const values = [];
        let pIndex = 1;

        for (const col of spec.columns) {
          const val = row[col];
          if (val === null || val === undefined) continue;

          if (spec.type === 'jsonb') {
            setParts.push(`${col} = $${pIndex++}::jsonb`);
            values.push(JSON.stringify(val));
          } else {
            setParts.push(`${col} = $${pIndex++}`);
            values.push(val);
          }
        }

        if (setParts.length > 0) {
          values.push(pkVal);
          const updateQuery = `UPDATE ${spec.table} SET ${setParts.join(', ')} WHERE ${spec.pk} = $${pIndex};`;
          const res = await targetClient.query(updateQuery, values);
          stats[spec.table] += res.rowCount;
          totalUpdatedRows += res.rowCount;
        }
      }

      console.log(`  ✓ ${spec.table.padEnd(28)} : ${stats[spec.table]} rows updated`);
    }

    // Commit Transaction
    await targetClient.query("COMMIT;");
    console.log("\n✓ Transaction COMMITTED successfully! All updates applied.\n");

    console.log("=======================================================================");
    console.log(`  MIGRATION SUMMARY: ${totalUpdatedRows} TOTAL ROWS SYNCHRONIZED`);
    console.log("=======================================================================");
    for (const [table, count] of Object.entries(stats)) {
      if (count > 0) {
        console.log(`  - ${table.padEnd(28)}: ${count} rows`);
      }
    }
    console.log("\nNext Step: Run verification script to confirm all media loads properly:");
    console.log("  node scripts/verify_local_uat_media.js");
    console.log("=======================================================================\n");

    targetClient.release();
  } catch (err) {
    console.error("\n✖ Migration Error encountered:", err);
    if (targetPool) {
      try {
        const client = await targetPool.connect();
        await client.query("ROLLBACK;");
        client.release();
        console.log("✓ Target DB transaction ROLLED BACK safely. No partial changes committed.");
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr.message);
      }
    }
  } finally {
    await sourcePool.end();
    if (targetPool) await targetPool.end();
  }
}

main();
