const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function run() {
  try {
    await client.connect();
    
    const sql = `
      CREATE TABLE IF NOT EXISTS ai_jd_cache (
          role_hash VARCHAR(64) PRIMARY KEY,
          role_name TEXT NOT NULL,
          company_name TEXT,
          ai_content JSONB NOT NULL,
          hit_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          last_used_at TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',
          prompt_version VARCHAR(10) DEFAULT 'v1.0'
      );
    `;
    
    await client.query(sql);
    console.log("Successfully created ai_jd_cache table!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await client.end();
  }
}

run();
