const pool = require("../../core/db/pool");

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
  const { account_name, location_id, full_name, finish } = req.body;
  const shouldFinish = finish === "true" || finish === true;
  const userId = req.user.sub;

  try {
    // 1. Fetch current user data
    const userResult = await pool.query(
      "SELECT is_onboarding_complete, avatar_url, full_name as existing_full_name, account_name as existing_account_name, location_id as existing_location_id FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const currentUser = userResult.rows[0];

    // 2. Avatar logic: Use new file if uploaded, otherwise keep existing
    let finalAvatarUrl = currentUser.avatar_url;
    if (req.files && req.files.length > 0) {
      finalAvatarUrl = req.files[0].path.replace(/\\/g, "/");
    }

    // 3. Check uniqueness of account_name (only if provided and different)
    if (account_name && account_name !== currentUser.existing_account_name) {
      const nameCheck = await pool.query(
        "SELECT 1 FROM users WHERE lower(account_name) = lower($1) AND user_id != $2",
        [account_name, userId]
      );

      if (nameCheck.rowCount > 0) {
        return res.status(409).json({ message: "Account name already taken" });
      }
    }

    // 4. Validate location_id against DB and fetch canonical name
    let locationName = null;
    let finalLocationId = location_id || currentUser.existing_location_id;

    if (finalLocationId) {
      const locationResult = await pool.query(
        "SELECT id, name FROM locations WHERE id = $1",
        [finalLocationId]
      );

      if (locationResult.rowCount > 0) {
        locationName = locationResult.rows[0].name;
      }
    }

    // 5. Update user
    await pool.query(
      `UPDATE users
       SET account_name = COALESCE($1, account_name),
           avatar_url = COALESCE($2, avatar_url),
           location = COALESCE($3, location),
           location_id = COALESCE($4, location_id),
           full_name = COALESCE($5, full_name),
           is_onboarding_complete = CASE WHEN $6 = TRUE THEN TRUE ELSE is_onboarding_complete END,
           updated_at = NOW()
       WHERE user_id = $7`,
      [account_name || null, finalAvatarUrl || null, locationName || null, finalLocationId || null, full_name || null, shouldFinish, userId]
    );

    return res.status(200).json({
      message: "Onboarding updated successfully",
      user: {
        account_name: account_name || currentUser.existing_account_name,
        avatar_url: finalAvatarUrl,
        location: locationName,
        location_id: finalLocationId,
        full_name: full_name || currentUser.existing_full_name,
        is_onboarding_complete: shouldFinish || currentUser.is_onboarding_complete
      }
    });

  } catch (err) {
    console.error("Complete onboarding error:", err);
    if (err.code === '23505') {
       return res.status(409).json({ message: "Account name already taken" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
};
