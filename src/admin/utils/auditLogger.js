const pool = require('../../core/db/pool');

/**
 * Logs critical admin, developer, and moderator actions to the database.
 * 
 * @param {string} userId - The UUID of the admin performing the action
 * @param {string} actionType - E.g., 'LOGIN', 'SUSPEND_USER', 'UPDATE_SETTINGS'
 * @param {string} description - Human readable description of the action
 * @param {string} ipAddress - The IP address of the user (optional)
 */
exports.logAdminActivity = async (userId, actionType, description, ipAddress = null) => {
  try {
    if (!userId) return; // Cannot log anonymous actions
    
    await pool.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description, ip_address, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, actionType, description, ipAddress]
    );
  } catch (error) {
    console.error('Failed to write admin audit log:', error);
    // We intentionally don't throw here so that a failed log doesn't break the main API request
  }
};
