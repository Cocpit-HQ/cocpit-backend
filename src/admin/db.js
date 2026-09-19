const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST || '192.168.1.50',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'cocpit_intern_instance',
  user: process.env.DB_USER || 'nirzara',
  password: process.env.DB_PASSWORD || 'cocpit@4713'
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => req.db.query(text, params),
  pool,
};
