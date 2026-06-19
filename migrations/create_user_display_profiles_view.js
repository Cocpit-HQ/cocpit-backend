require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/core/db/pool');

async function up() {
  const query = `
    CREATE OR REPLACE VIEW user_display_profiles AS
    SELECT
        user_id,
        account_name AS original_username,

        CASE
            WHEN deletion_execute_at IS NULL THEN full_name
            ELSE 'Deactivated User'
        END AS display_name,

        CASE
            WHEN deletion_execute_at IS NULL THEN account_name
            ELSE 'deactivated_user'
        END AS display_username,

        CASE
            WHEN deletion_execute_at IS NULL THEN avatar_url
            ELSE NULL
        END AS display_avatar,

        CASE
            WHEN deletion_execute_at IS NULL THEN headline
            ELSE 'This account has been deactivated'
        END AS display_headline,

        CASE
            WHEN deletion_execute_at IS NULL THEN location
            ELSE NULL
        END AS location
    FROM users;
  `;

  try {
    console.log("Creating user_display_profiles view...");
    await pool.query(query);
    console.log("user_display_profiles view created successfully!");
  } catch (error) {
    console.error("Error creating user_display_profiles view:", error);
  } finally {
    process.exit(0);
  }
}

up();
