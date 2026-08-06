require('dotenv').config();
const pool = require('./src/core/db/pool');

const query = `
-- 1. Add columns to users table
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- 2. Update active_users view
CREATE OR REPLACE VIEW active_users AS
SELECT * FROM users
WHERE deletion_execute_at IS NULL AND is_deactivated = FALSE;

-- 3. Update user_display_profiles view
CREATE OR REPLACE VIEW user_display_profiles AS
SELECT
    user_id,
    account_name AS original_username,

    CASE
        WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN full_name
        ELSE 'Deactivated User'
    END AS display_name,

    CASE
        WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN account_name
        ELSE 'deactivated_user'
    END AS display_username,

    CASE
        WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN avatar_url
        ELSE NULL
    END AS display_avatar,

    CASE
        WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN headline
        ELSE 'This account has been deactivated'
    END AS display_headline,

    CASE
        WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN location
        ELSE NULL
    END AS location
FROM users;
`;

pool.query(query).then(() => {
    console.log('User deactivation migration successful.');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
