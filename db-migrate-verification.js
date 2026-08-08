const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  try {
    console.log("Starting account verification migration...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_verifications (
        verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        verification_type VARCHAR(50) DEFAULT 'IDENTITY',
        front_image_url TEXT NOT NULL,
        back_image_url TEXT,
        is_verified BOOLEAN DEFAULT FALSE,
        status VARCHAR(20) DEFAULT 'VERIFIED',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("Created user_verifications table.");

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_identity_verified BOOLEAN DEFAULT FALSE;
    `);
    console.log("Added is_identity_verified to users.");

    // Update existing schema.sql to include these changes
    const fs = require('fs');
    let schema = fs.readFileSync('schema.sql', 'utf8');
    
    if (!schema.includes('user_verifications')) {
        schema += `\n\n-- Added for user identity verification\nCREATE TABLE user_verifications (\n  verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,\n  verification_type VARCHAR(50) DEFAULT 'IDENTITY',\n  front_image_url TEXT NOT NULL,\n  back_image_url TEXT,\n  is_verified BOOLEAN DEFAULT FALSE,\n  status VARCHAR(20) DEFAULT 'VERIFIED',\n  created_at TIMESTAMPTZ DEFAULT now(),\n  updated_at TIMESTAMPTZ DEFAULT now()\n);\n`;
        fs.writeFileSync('schema.sql', schema);
        console.log("Appended user_verifications to schema.sql");
    }

  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    pool.end();
  }
}

run();
