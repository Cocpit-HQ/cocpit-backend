require('dotenv').config();
const pool = require('./src/core/db/pool');

async function updateView() {
  const query = `
    CREATE OR REPLACE VIEW user_display_profiles AS
    SELECT
        user_id,
        account_name AS original_username,
        CASE 
            WHEN is_suspended = TRUE THEN 'Unknown User'
            WHEN deletion_execute_at IS NOT NULL OR is_deactivated = TRUE THEN 'Deactivated User' 
            ELSE full_name 
        END AS display_name,
        CASE 
            WHEN is_suspended = TRUE THEN 'unknown_user'
            WHEN deletion_execute_at IS NOT NULL OR is_deactivated = TRUE THEN 'deactivated_user' 
            ELSE account_name 
        END AS display_username,
        CASE 
            WHEN is_suspended = TRUE THEN NULL
            WHEN deletion_execute_at IS NOT NULL OR is_deactivated = TRUE THEN NULL 
            ELSE avatar_url 
        END AS display_avatar,
        CASE 
            WHEN is_suspended = TRUE THEN 'This account is suspended'
            WHEN deletion_execute_at IS NOT NULL OR is_deactivated = TRUE THEN 'This account has been deactivated' 
            ELSE headline 
        END AS display_headline,
        CASE 
            WHEN is_suspended = TRUE THEN NULL
            WHEN deletion_execute_at IS NOT NULL OR is_deactivated = TRUE THEN NULL 
            ELSE location 
        END AS location
    FROM users;
  `;
  try {
    await pool.query(query);
    console.log('Successfully updated user_display_profiles view.');
  } catch (err) {
    console.error('Error updating view:', err);
  } finally {
    process.exit(0);
  }
}

updateView();
