require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function runMigration() {
  try {
    console.log(`Connecting to database ${process.env.DB_NAME} at ${process.env.DB_HOST}...`);
    
    const migrationPath = path.join(__dirname, '../migrations/analytics_schema.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Executing migration script...');
    await pool.query(sql);
    
    console.log('✅ Migration executed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

runMigration();
