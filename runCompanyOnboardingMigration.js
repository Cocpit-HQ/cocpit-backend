require("dotenv").config();
const pool = require('./src/core/db/pool');

const sql = `
BEGIN;

-- 1. Alter organizations table to support onboarding steps
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS country VARCHAR(100),
ADD COLUMN IF NOT EXISTS city VARCHAR(100),
ADD COLUMN IF NOT EXISTS headline VARCHAR(200),
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS onboarding_step VARCHAR(50) DEFAULT 'IDENTITY',
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by);
CREATE INDEX IF NOT EXISTS idx_organizations_onboarding_completed ON organizations(onboarding_completed) WHERE onboarding_completed = FALSE;

-- 2. Alter organization verifications table to support multi-channel OTPs
ALTER TABLE organization_verifications
ADD COLUMN IF NOT EXISTS verification_type VARCHAR(20) DEFAULT 'EMAIL' CHECK (verification_type IN ('EMAIL', 'PHONE', 'EDU_EMAIL', 'DOCUMENT')),
ADD COLUMN IF NOT EXISTS target_value VARCHAR(255),
ADD COLUMN IF NOT EXISTS request_count INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_org_verifications_lookup ON organization_verifications(org_id, verification_type, is_verified);

-- 3. Create organization_documents table
CREATE TABLE IF NOT EXISTS organization_documents (
    document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    document_url TEXT NOT NULL,
    document_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_documents_org_id ON organization_documents(org_id);

COMMIT;
`;

async function run() {
  console.log("Running Company Onboarding DB Migration...");
  try {
    await pool.query(sql);
    console.log("Migration successful!");
  } catch (e) {
    console.error("Migration failed:", e);
  } finally {
    process.exit(0);
  }
}

run();
