const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

const getPoolConfig = (dbUrl, host, port, user, password, dbName) => {
  const isInternal = Boolean(
    (dbUrl && (dbUrl.includes('.railway.internal') || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1'))) ||
    (host && (host.includes('.railway.internal') || host.includes('localhost') || host.includes('127.0.0.1')))
  );

  if (dbUrl && dbUrl.trim().length > 0) {
    return {
      connectionString: dbUrl,
      ssl: (isProduction && !isInternal) ? { rejectUnauthorized: false } : false,
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000,
    };
  }
  return {
    host: host || "localhost",
    port: port ? Number(port) : 5432,
    user: user,
    password: password,
    database: dbName,
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
    ssl: false,
  };
};

const pools = {};

function getPool(environment) {
  if (!environment) environment = 'staging';

  if (pools[environment]) return pools[environment];

  let config;
  if (environment === 'production') {
    config = getPoolConfig(
      process.env.PROD_DATABASE_URL || process.env.DATABASE_URL,
      process.env.PROD_DB_HOST || process.env.DB_HOST,
      process.env.PROD_DB_PORT || process.env.DB_PORT,
      process.env.PROD_DB_USER || process.env.DB_USER,
      process.env.PROD_DB_PASSWORD || process.env.DB_PASSWORD,
      process.env.PROD_DB_NAME || process.env.DB_NAME
    );
  } else if (environment === 'uat') {
    config = getPoolConfig(
      process.env.UAT_DATABASE_URL || process.env.DATABASE_URL,
      process.env.UAT_DB_HOST || process.env.DB_HOST,
      process.env.UAT_DB_PORT || process.env.DB_PORT,
      process.env.UAT_DB_USER || process.env.DB_USER,
      process.env.UAT_DB_PASSWORD || process.env.DB_PASSWORD,
      process.env.UAT_DB_NAME || process.env.DB_NAME
    );
  } else {
    // staging or fallback
    config = getPoolConfig(
      process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL,
      process.env.STAGING_DB_HOST || process.env.DB_HOST,
      process.env.STAGING_DB_PORT || process.env.DB_PORT,
      process.env.STAGING_DB_USER || process.env.DB_USER,
      process.env.STAGING_DB_PASSWORD || process.env.DB_PASSWORD,
      process.env.STAGING_DB_NAME || process.env.DB_NAME
    );
  }

  const pool = new Pool(config);

  pool.on("error", (err) => {
    console.error(`🔥 Unexpected PostgreSQL error on idle client [${environment}]`, err);
  });

  // Verify connection asynchronously without blocking
  pool.query("SELECT current_database(), current_user")
    .then(res => {
      console.log(`✅ PostgreSQL connected [${environment}]`);
      console.log(`📦 Database [${environment}]:`, res.rows[0].current_database);
    })
    .catch(err => {
      console.warn(`⚠️ PostgreSQL not reachable for environment [${environment}]`, err.message);
    });

  pools[environment] = pool;
  return pool;
}

module.exports = {
  getPool,
};
