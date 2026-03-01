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
 * Startup DB health check
 */
(async () => {
  try {
    const res = await pool.query(
      "SELECT current_database(), current_user"
    );
    console.log("✅ PostgreSQL connected");
    console.log("📦 Database:", res.rows[0].current_database);
    console.log("👤 DB User:", res.rows[0].current_user);
  } catch (err) {
    console.error("❌ PostgreSQL connection failed");
    console.error(err.message);
    process.exit(1);
  }
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
