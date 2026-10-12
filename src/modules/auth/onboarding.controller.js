const pool = require("../../core/db/pool");
const { signAccessToken } = require("../../core/utils/jwt");
const authRepo = require("./auth.repository");

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
  const sessionId = req.user.sid; // Keep the same session ID

  try {
    // 1. Fetch current user data
    const userResult = await pool.query(
      "SELECT is_onboarding_complete, avatar_url, full_name as existing_full_name, account_name as existing_account_name FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const currentUser = userResult.rows[0];

    // Misuse Protection: If onboarding is already finished and they try to finish again, block or ignore
    if (currentUser.is_onboarding_complete && shouldFinish) {
      return res.status(400).json({ 
        message: "Onboarding already completed",
        code: "ONBOARDING_ALREADY_FINISHED" 
      });
    }

    // 2. Avatar logic: Use new file if uploaded, otherwise keep existing (ignoring legacy Google avatar)
    let finalAvatarUrl = currentUser.avatar_url;
    if (finalAvatarUrl && (finalAvatarUrl.includes("googleusercontent.com") || finalAvatarUrl.includes("ggpht.com"))) {
      finalAvatarUrl = null;
    }
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

    // 4. Validate location against DB and fetch canonical name
    let locationName = null;
    let newLocationFields = null;
    const newLocationPayload = req.body.location; 

    if (newLocationPayload && newLocationPayload.placeId) {
        locationName = newLocationPayload.formattedAddress;
        newLocationFields = {
            location_formatted: newLocationPayload.formattedAddress,
            location_country: newLocationPayload.country,
            location_state: newLocationPayload.state || null,
            location_city: newLocationPayload.city,
            location_lat: newLocationPayload.latitude || null,
            location_lng: newLocationPayload.longitude || null,
            location_place_id: newLocationPayload.placeId,
        };
    }

    // 5. Update user
    let updateQuery = `UPDATE users
       SET account_name = COALESCE($1, account_name),
           avatar_url = COALESCE($2, avatar_url),
           location = COALESCE($3, location),
           full_name = COALESCE($4, full_name),
           is_onboarding_complete = CASE WHEN $5 = TRUE THEN TRUE ELSE is_onboarding_complete END,
           updated_at = NOW()
       WHERE user_id = $6`;
    let updateParams = [account_name || null, finalAvatarUrl || null, locationName || null, full_name || null, shouldFinish, userId];

    if (newLocationFields) {
        updateQuery = `UPDATE users
           SET account_name = COALESCE($1, account_name),
               avatar_url = COALESCE($2, avatar_url),
               location = COALESCE($3, location),
               full_name = COALESCE($4, full_name),
               is_onboarding_complete = CASE WHEN $5 = TRUE THEN TRUE ELSE is_onboarding_complete END,
               location_formatted = $6,
               location_country = $7,
               location_state = $8,
               location_city = $9,
               location_lat = $10,
               location_lng = $11,
               location_place_id = $12,
               updated_at = NOW()
           WHERE user_id = $13`;
        updateParams = [
            account_name || null, finalAvatarUrl || null, locationName || null, full_name || null, shouldFinish,
            newLocationFields.location_formatted, newLocationFields.location_country, newLocationFields.location_state,
            newLocationFields.location_city, newLocationFields.location_lat, newLocationFields.location_lng, newLocationFields.location_place_id,
            userId
        ];
    }

    await pool.query(updateQuery, updateParams);

    // 6. If finishing, generate a new accessToken with onboarding_complete: true
    let newToken = null;
    if (shouldFinish) {
      const roles = await authRepo.getUserRoles(userId);
      newToken = signAccessToken({
        sub: userId,
        sid: sessionId, // Consistency: Use same session ID
        roles,
        onboarding_complete: true
      });
    }

    return res.status(200).json({
      message: shouldFinish ? "Onboarding completed successfully" : "Onboarding updated successfully",
      accessToken: newToken, // Return new token only on finish
      user: {
        account_name: account_name || currentUser.existing_account_name,
        avatar_url: finalAvatarUrl,
        location: locationName,
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
