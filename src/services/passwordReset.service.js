const pool = require("../core/db/pool");
const { hashPassword } = require("../core/utils/password");

/**
 * Reset user password
 * @param {string} email - User email
 * @param {string} newPassword - New password (plain text)
 * @returns {Promise<Object>} Result object
 */
const resetPassword = async (email, newPassword) => {
    const normalizedEmail = email.toLowerCase();

    // Check if user exists
    const userResult = await pool.query(
        "SELECT user_id FROM users WHERE email = $1",
        [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
        throw new Error("User not found");
    }

    const userId = userResult.rows[0].user_id;

    // Hash the new password
    const passwordHash = await hashPassword(newPassword);

    // Update password in database
    await pool.query(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE user_id = $2",
        [passwordHash, userId]
    );

    return {
        success: true,
        message: "Password reset successfully",
    };
};

module.exports = {
    resetPassword,
};
