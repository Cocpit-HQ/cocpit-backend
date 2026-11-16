-- Migration 021: Add user verification lifecycle columns and organization document status
-- Purpose: PR #566 Admin Panel User & Org Verification

-- 1. Add verification review lifecycle columns to user_verifications
ALTER TABLE user_verifications 
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2. Ensure organization_documents has status column
ALTER TABLE organization_documents
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PENDING';