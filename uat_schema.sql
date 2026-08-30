-- UAT Schema Initialization

-- Migration for email_otps table changes by Swaroop
ALTER TABLE email_otps 
    ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(100) NOT NULL DEFAULT 'signup',
    DROP CONSTRAINT IF EXISTS unique_email_otp_purpose,
    ADD CONSTRAINT unique_email_otp_purpose UNIQUE (email, purpose);
