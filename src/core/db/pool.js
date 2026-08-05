const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

// Prefer DATABASE_URL if present, else fallback to individual vars

// hello this is new comment
// Prefer DATABASE_URL if present, else fallback to individual vars
// FORCE: Using individual vars to ensure we connect to correct DB host (ignoring potential wrong system DATABASE_URL)
const poolConfig = (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0)
  ? {
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction
      ? { rejectUnauthorized: false }
      : false,
  }
  : {
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 15, // max clients in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: false,
  };

const pool = new Pool(poolConfig);

/**
 * Startup DB health check — non-fatal with retry
 * Server stays alive even if DB host is temporarily unreachable.
 */
let _dbConnected = false;

async function checkDbConnection() {
  try {
    const res = await pool.query("SELECT current_database(), current_user");
    if (!_dbConnected) {
      console.log("✅ PostgreSQL connected");
      console.log("📦 Database:", res.rows[0].current_database);
      console.log("👤 DB User:", res.rows[0].current_user);
      _dbConnected = true;

      // Drop foreign key constraints on blocks table and ensure password_reset_tokens table exists
      pool.query(`
        ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocked_id_fkey;
        ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocker_id_fkey;

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          used BOOLEAN DEFAULT FALSE
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
      `).catch(err => console.warn("Blocks schema constraint drop notice:", err.message));
    }
    return true;
  } catch (err) {
    console.warn("⚠️  PostgreSQL not yet reachable — will retry in 30s");
    console.warn(`   Host: ${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || 5432}`);
    console.warn(`   Reason: ${err.message}`);
    _dbConnected = false;
    return false;
  }
}

// Initial check + periodic retry every 30 seconds
(async () => {
  await checkDbConnection();
  setInterval(checkDbConnection, 30_000);
})();

/**
 * Pool error handling
 * Prevent crash on transient errors
 */
pool.on("error", (err) => {
  console.error("🔥 Unexpected PostgreSQL error on idle client", err);
  // Do NOT exit process. attempts to reconnect/recover.
  // process.exit(1); 
});

module.exports = pool;
