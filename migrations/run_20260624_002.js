/**
 * Migration Runner: 20260624_002_application_notes_and_ai_analyses
 *
 * Adds two tables:
 *   - application_notes       (recruiter self-notes per application)
 *   - application_ai_analyses (AI evaluation results — contract table)
 *
 * Usage:
 *   node migrations/run_20260624_002.js
 *
 * Safe to run multiple times (SQL uses IF NOT EXISTS).
 */

require('dotenv').config();
const pool = require('../src/core/db/pool');
const fs   = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '20260624_002_application_notes_and_ai_analyses.sql');
const MIGRATION_NAME = '20260624_002_application_notes_and_ai_analyses';

async function run() {
  const client = await pool.connect();
  console.log(`\n🚀 Running migration: ${MIGRATION_NAME}`);

  try {
    // Ensure migration tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        applied_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Skip if already applied
    const already = await client.query(
      `SELECT 1 FROM schema_migrations WHERE migration_name = $1`,
      [MIGRATION_NAME]
    );

    if (already.rowCount > 0) {
      console.log(`⏭️  Migration already applied — skipping.`);
      process.exit(0);
    }

    // Read and execute SQL
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    await client.query(sql);

    // Record as applied
    await client.query(
      `INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [MIGRATION_NAME]
    );

    console.log(`✅ Migration applied successfully: ${MIGRATION_NAME}`);
  } catch (err) {
    console.error(`❌ Migration failed: ${MIGRATION_NAME}`);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
