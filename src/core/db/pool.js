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
    // Connection limits & timeouts
    max: 30,                          // max clients in pool (was 15 — too low under load)
    idleTimeoutMillis: 20000,         // release idle clients after 20s
    connectionTimeoutMillis: 5000,    // fail fast if pool is exhausted
    statement_timeout: 60000,         // kill any query running > 60s
    query_timeout: 60000,             // node-postgres client-side query timeout
  }
  : {
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // ─── Connection pool limits ───────────────────────────────────────────────
    max: 30,                          // max clients (was 15 — too low under load)
    idleTimeoutMillis: 20000,         // release idle clients after 20s
    connectionTimeoutMillis: 5000,    // fail fast if pool is exhausted
    // ─── Server-side timeouts (sent to Postgres on every new connection) ──────
    statement_timeout: 60000,         // kill any query running > 60s
    query_timeout: 60000,             // node-postgres client-side query timeout
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
        ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;
        CREATE OR REPLACE VIEW active_users AS 
        SELECT * FROM users 
        WHERE (is_deleted IS FALSE OR is_deleted IS NULL) 
          AND (is_suspended IS FALSE OR is_suspended IS NULL)
          AND deletion_execute_at IS NULL;

        CREATE OR REPLACE VIEW active_organizations AS 
        SELECT * FROM organizations 
        WHERE (is_deleted IS FALSE OR is_deleted IS NULL) 
          AND (is_suspended IS FALSE OR is_suspended IS NULL) 
          AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

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

        -- Feature flag PostgreSQL LISTEN/NOTIFY trigger
        CREATE OR REPLACE FUNCTION notify_feature_flag_update()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('feature_flags_updated', json_build_object(
            'key', NEW.flag_key,
            'value', NEW.is_enabled
          )::text);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS feature_flags_update_trigger ON feature_flags;
        CREATE TRIGGER feature_flags_update_trigger
        AFTER INSERT OR UPDATE ON feature_flags
        FOR EACH ROW EXECUTE FUNCTION notify_feature_flag_update();
      `).catch(err => console.warn("Database schema update notice:", err.message));
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
let healthCheckInterval;
(async () => {
  await checkDbConnection();
  healthCheckInterval = setInterval(checkDbConnection, 30_000);
})();

pool.stopHealthCheck = () => {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
};

/**
 * Pool error handling
 * Prevent crash on transient errors
 */
pool.on("error", (err) => {
  console.error("🔥 Unexpected PostgreSQL error on idle client", err);
  // Do NOT exit process. attempts to reconnect/recover.
  // process.exit(1); 
});

/**
 * Pool telemetry — log connection stats to spot exhaustion early.
 * Visible in the backend terminal under load.
 */
/**pool.on("connect", () => {
  console.log(`[pg-pool] client connected | total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
});

pool.on("remove", () => {
  console.log(`[pg-pool] client removed   | total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
});*/

module.exports = pool;
