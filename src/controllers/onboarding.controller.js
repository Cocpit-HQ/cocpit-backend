const pool = require("../db/pool");

exports.checkAccountName = async (req, res) => {
  const { account_name } = req.query;

  try {
    const result = await pool.query(
      "SELECT 1 FROM users WHERE lower(account_name) = lower($1)",
      [account_name]
    );

    const available = result.rowCount === 0;
    return res.json({ available });
  } catch (err) {
    console.error("Check account name error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.completeOnboarding = async (req, res) => {
  const { account_name } = req.body;
  const userId = req.user.sub;

  // 1. Check if file is uploaded
  if (!req.file) {
    return res.status(400).json({ message: "Avatar image is required" });
  }

  try {
    // 2. Check if user already completed onboarding
    const userResult = await pool.query(
      "SELECT is_onboarding_complete FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (userResult.rows[0].is_onboarding_complete) {
       return res.status(403).json({ message: "Onboarding already completed" });
    }

    // 3. Check uniqueness of account_name again (race condition check)
    const nameCheck = await pool.query(
      "SELECT 1 FROM users WHERE lower(account_name) = lower($1) AND user_id != $2",
      [account_name, userId]
    );

    if (nameCheck.rowCount > 0) {
      return res.status(409).json({ message: "Account name already taken" });
    }

    // 4. Update user
    const avatarUrl = req.file.path;

    await pool.query(
      `UPDATE users
       SET account_name = $1,
           avatar_url = $2,
           is_onboarding_complete = TRUE,
           updated_at = NOW()
       WHERE user_id = $3`,
      [account_name, avatarUrl, userId]
    );

    return res.status(200).json({
      message: "Onboarding completed successfully",
      user: {
        account_name,
        avatar_url: avatarUrl,
        is_onboarding_complete: true
      }
    });

  } catch (err) {
    console.error("Complete onboarding error:", err);
    // Unique constraint violation code 23505 (just in case)
    if (err.code === '23505') {
       return res.status(409).json({ message: "Account name already taken" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
};
