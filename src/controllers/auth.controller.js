const pool = require("../db/pool");
const { hashPassword, comparePassword } = require("../utils/password");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  verifyAccessToken
} = require("../utils/jwt");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const UAParser = require("ua-parser-js");

const cookieOptions = {
  httpOnly: true,
  secure: true, // Required for SameSite: None
  sameSite: "None",
  path: "/",
};

exports.register = async (req, res) => {
  const { email, password, fullName, accountType } = req.body;

  try {
    const normalizedEmail = email.toLowerCase();

    // 1. Check if user exists
    const exists = await pool.query(
      "SELECT 1 FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (exists.rowCount > 0) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const passwordHash = await hashPassword(password);
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING user_id, email, full_name`,
      [normalizedEmail, passwordHash, fullName]
    );

    const user = userResult.rows[0];

    let roleName;
    if (accountType === 'Admin') roleName = 'Admin';
    else if (accountType === 'Employer') roleName = 'Employer';
    else roleName = 'Student';

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, role_id FROM roles WHERE role_name = $2`,
      [user.user_id, roleName]
    );

    await pool.query(
      `INSERT INTO profiles (user_id, account_type) VALUES ($1, $2)`,
      [user.user_id, accountType]
    );

    res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (err) {
    console.error("Registration error:", err);
    if (err.code === '28P01') {
      return res.status(500).json({ error: "Database authentication failed. Please check your database credentials." });
    }
    res.status(500).json({ error: err.message });
  }
};

// exports.login = async (req, res) => {
//   const { email, password } = req.body;
//   const normalizedEmail = email.toLowerCase();
//   try {
//     const userResult = await pool.query(
//       `
//       SELECT user_id, email, password_hash
//       FROM users
//       WHERE email = $1
//       `,
//       [normalizedEmail]
//     );

//     if (userResult.rowCount === 0) {
//       return res.status(401).json({ message: "user not found" });
//     }

//     const user = userResult.rows[0];

//     const isValid = await comparePassword(password, user.password_hash);
//     if (!isValid) {
//       return res.status(401).json({ message: "Invalid credentials" });
//     }

//     // Fetch roles
//     const rolesResult = await pool.query(
//       `
//       SELECT r.role_name
//       FROM user_roles ur
//       JOIN roles r ON r.role_id = ur.role_id
//       WHERE ur.user_id = $1
//       `,
//       [user.user_id]
//     );

//     const roles = rolesResult.rows.map(r => r.role_name);
//     const MAX_DEVICES = 2;
//     const userAgent = req.headers["user-agent"];
//     const ipAddress = req.ip;
//     const authHeader = req.headers.authorization;
//     if (!authHeader) {
//       return res.status(401).json({ message: "Missing token" });
//     }
//     const oldAccessToken = authHeader.split(" ")[1];
//     const payload = verifyAccessToken(accessToken);

//     const { sid: sessionId } = payload;
//     const existingSessionId = sessionId;
//     const newSessionId = existingSessionId===null?crypto.randomUUID():existingSessionId;

//     // Generate tokens
//     const accessToken = signAccessToken({
//       sub: user.user_id,
//       roles,
//       sid: newSessionId,
//     });

//     const refreshToken = signRefreshToken({
//       sub: user.user_id,
//     });
//     const hashedRefresh = await bcrypt.hash(refreshToken, 12);

//     await pool.query("BEGIN");
//     try {

//       const existingDevice = await pool.query(
//         `SELECT token_id
//     FROM refresh_tokens
//     WHERE user_id = $1
//       AND session_id = $2
//       AND ip_address = $3
//       AND expires_at > now()`,
//         [user.user_id, sessionId, ipAddress]
//       );

//       if (existingDevice.rowCount > 0) {
//         //  Same device login → UPDATE token
//         await pool.query(
//           ` UPDATE refresh_tokens
//       SET token_hash = $1,
//           expires_at = now() + interval '7 days',
//           created_at = now()
//       WHERE token_id = $2`,
//           [hashedRefresh, existingDevice.rows[0].token_id]
//         );
//       }
//       else {
//         //  Count active sessions
//         const { rows } = await pool.query(
//           ` SELECT COUNT(*)::int AS count
//     FROM refresh_tokens
//     WHERE user_id = $1
//       AND revoked = FALSE
//       AND expires_at > now() `,
//           [user.user_id]
//         );

//         const activeDevices = rows[0].count;
//         //  Revoke oldest session IF limit exceeded
//         if (activeDevices >= MAX_DEVICES) {
//           await pool.query(
//             `delete from refresh_tokens where  token_id = (
//         SELECT token_id
//         FROM refresh_tokens
//         WHERE user_id = $1
//           AND revoked = FALSE
//           AND expires_at > now()
//         ORDER BY created_at ASC
//         LIMIT 1 ) `,
//             [user.user_id]
//           );
//         }

//         await pool.query(
//           `INSERT INTO refresh_tokens
//   (session_id, user_id, token_hash, expires_at, user_agent,ip_address)
//   VALUES ($1, $2, $3, now() + interval '7 days', $4,$5)
//   `, [sessionId, user.user_id, hashedRefresh, userAgent, ipAddress]
//         );
//       }

//       await pool.query("COMMIT");
//     } catch (err) {
//       await pool.query("ROLLBACK");
//       throw err;
//     }
//     // Set Refresh Token in HTTP-only cookie
//     res.cookie('refreshToken', refreshToken, {
//       httpOnly: true, // Changed to true for security, original was false
//       secure: true, // Always true for None
//       sameSite: 'None',
//       maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
//     });
//     console.log("login done : ", normalizedEmail, "accessToken", accessToken, "refreshToken", refreshToken);

//     //  res.set("Authorization", `Bearer ${accessToken}`);
//     res.status(200).json({
//       "accessToken": accessToken,
//       "refreshToken": refreshToken,
//       user: {
//         "id": user.user_id,
//         "email": user.email,
//         "fullName": user.full_name,
//         "roles": roles,
//         "sessionId": sessionId,
//         "userAgent": userAgent,
//         "ipAddress": ipAddress

//       }
//     });
//   } catch (err) {
//     if (err.code === '28P01') {
//       return res.status(500).json({ error: "Database authentication failed. Please check your database credentials." });
//     }
//     res.status(500).json({ message: "Internal server error" });
//   }
// };

// exports.refreshToken = async (req, res) => {
//   const authHeader = req.headers.authorization;
//   if (!authHeader) {
//     return res.status(401).json({ message: "Missing token" });
//   }
//   const accessToken = authHeader.split(" ")[1];
//   const payload = verifyAccessToken(accessToken);

//   try {
//     const { sub: userId, sid: sessionId } = payload;
//     const ipAddress = req.ip;

//     //  Fetch stored token for SAME device
//     const tokenResult = await pool.query(
//       `  SELECT token_id, token_hash
//       FROM refresh_tokens
//       WHERE user_id = $1
//         AND session_id = $2
//         AND ip_address = $3
//         AND expires_at > now()
//       `, [userId, sessionId, ipAddress]
//     );

//     if (tokenResult.rowCount === 0) {
//       res.clearCookie("refreshToken");
//       return res.status(403).json({ message: "Invalid refresh token" });
//     }

//     const { token_id, token_hash } = tokenResult.rows[0];

//     const isValid = await bcrypt.compare(refreshToken, token_hash);
//     if (!isValid) {
//       await pool.query(
//         `DELETE FROM refresh_tokens
//         WHERE token_id = $1`,
//         [token_id]
//       );

//       res.clearCookie("refreshToken");
//       return res.status(403).json({ message: "Invalid refresh token" });
//     }

//     // Fetch roles
//     const rolesResult = await pool.query(
//       ` SELECT r.role_name
//       FROM user_roles ur
//       JOIN roles r ON r.role_id = ur.role_id
//       WHERE ur.user_id = $1
//       `, [userId]
//     );
//     const roles = rolesResult.rows.map(r => r.role_name);

//     //  Generate new tokens
//     const newAccessToken = signAccessToken({
//       sub: userId,
//       roles,
//       sid: sessionId
//     });
//     const newRefreshToken = signRefreshToken({
//       sub: userId,
//     });

//     const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 12);

//     //  Rotate refresh token for SAME device (UPDATE, not DELETE)
//     await pool.query(
//       `UPDATE refresh_tokens
//       SET token_hash = $1,
//           expires_at = now() + interval '7 days',
//           created_at = now()
//       WHERE token_id = $2
//       `, [hashedNewRefreshToken, token_id]
//     );

//     // Set new refresh token cookie
//     res.cookie("refreshToken", newRefreshToken, {
//       httpOnly: false,
//       secure: process.env.NODE_ENV === "production",
//       sameSite: "Lax",
//       maxAge: 7 * 24 * 60 * 60 * 1000,
//     });

//     res.status(200).json({
//       accessToken: newAccessToken,
//       refreshToken: newRefreshToken,
//     });

//   } catch (err) {
//     console.error("Refresh token error:", err);
//     res.clearCookie("refreshToken");
//     return res.status(403).json({ message: "Invalid or expired refresh token" });
//   }
// };

// exports.logout = async (req, res) => {
//   const authHeader = req.headers.authorization;
//   if (!authHeader) {
//     return res.status(401).json({ message: "Missing token" });
//   }
//   const accessToken = authHeader.split(" ")[1];
//   const payload = verifyAccessToken(accessToken);

//   try {

//     const { sub: userId, sid: sessionId } = payload;
//     const userAgent = req.headers["user-agent"];
//     const ipAddress = req.ip;

//     //  Fetch stored token for SAME device
//     const tokenResult = await pool.query(
//       `SELECT token_id, token_hash
//       FROM refresh_tokens
//       WHERE user_id = $1
//         AND session_id = $2
//         AND ip_address = $3
//         AND expires_at > now()
//       `, [userId, sessionId, ipAddress]
//     );

//     if (tokenResult.rowCount === 0) {
//       res.clearCookie("refreshToken");

//       await pool.query(
//         `DELETE FROM refresh_tokens WHERE token_id = $1`,
//         [token_id]
//       );
//       return res.status(200).json({ message: "logged out" });
//     }

//     const { token_id, token_hash } = tokenResult.rows[0];
//     const isValid = await bcrypt.compare(accessToken, token_hash);
//     if (isValid) {
//       await pool.query(
//         `DELETE FROM refresh_tokens WHERE token_id = $1`,
//         [token_id]
//       );
//     }
//     console.log("logout donnee : ", accessToken);
//     res.clearCookie('refreshToken');
//     res.status(200).json({ message: "Logged out successfully" });

//   } catch (e) {
//     res.status(500).json({ message: "Internal server error" });
//   }


// };

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const userAgent = req.headers["user-agent"] || "unknown";
  const ipAddress = req.ip || "unknown";

  const normalizedEmail = email.toLowerCase();
  const sessionId = crypto.randomUUID();

  try {
    /* ---------------------------------------------------------
       1️⃣ Fetch user
    --------------------------------------------------------- */
    const userResult = await pool.query(
      `
      SELECT user_id, email, password_hash, is_onboarding_complete, account_name, full_name, avatar_url
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return res.status(401).json({ message: "User not found" });
    }

    const user = userResult.rows[0];

    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    /* ---------------------------------------------------------
       2️⃣ Fetch roles
    --------------------------------------------------------- */
    const rolesResult = await pool.query(
      `
      SELECT r.role_name
      FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = $1
      `,
      [user.user_id]
    );

    const roles = rolesResult.rows.map(r => r.role_name);

    /* ---------------------------------------------------------
       3️⃣ Generate tokens (SESSION-BASED)
    --------------------------------------------------------- */
    const accessToken = signAccessToken({
      sub: user.user_id,
      sid: sessionId,
      roles,
      onboarding_complete: user.is_onboarding_complete,
    });

    const refreshToken = signRefreshToken({
      sub: user.user_id,
      sid: sessionId,
    });

    const hashedRefresh = await bcrypt.hash(refreshToken, 12);

    /* ---------------------------------------------------------
       4️⃣ Enforce MAX_DEVICES (by SESSION)
    --------------------------------------------------------- */
    const MAX_DEVICES = 10;

    await pool.query("BEGIN");

    try {
      const activeSessions = await pool.query(
        `
        SELECT session_id
        FROM refresh_tokens
        WHERE user_id = $1
          AND expires_at > now()
        ORDER BY created_at ASC
        `,
        [user.user_id]
      );

      if (activeSessions.rowCount >= MAX_DEVICES) {
        // Remove OLDEST session
        await pool.query(
          `
          DELETE FROM refresh_tokens
          WHERE session_id = $1
          `,
          [activeSessions.rows[0].session_id]
        );
      }

      /* ---------------------------------------------------------
         5️⃣ Insert NEW session
      --------------------------------------------------------- */
      await pool.query(
        `
  INSERT INTO refresh_tokens
    (session_id, user_id, token_hash, expires_at, user_agent, ip_address)
  VALUES
    ($1, $2, $3, now() + interval '7 days', $4, $5)
  `,
        [sessionId, user.user_id, hashedRefresh, userAgent, ipAddress]
      );


      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    /* ---------------------------------------------------------
       6️⃣ Set refresh token cookie
    --------------------------------------------------------- */
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    console.log(
      "✅ Login successful:",
      normalizedEmail,
      "session:",
      sessionId
    );

    /* ---------------------------------------------------------
       7️⃣ Populate Block Cache (Async)
    --------------------------------------------------------- */
    const BlockModel = require("../models/block.model");
    BlockModel.cacheBlocks(user.user_id).catch(e => console.error("Block cache warm-up failed", e));

    /* ---------------------------------------------------------
       8️⃣ Respond
    --------------------------------------------------------- */
    return res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        roles,
        onboarding_complete: user.is_onboarding_complete,
        account_name: user.account_name,
      },
    });

  } catch (err) {
    console.error("❌ Login error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.refreshToken = async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token missing", refreshToken: refreshToken });
  }

  try {
    /* ---------------------------------------------------------
       1️⃣ Verify refresh token and extract session
    --------------------------------------------------------- */
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch (err) {
      console.warn("Refresh token verification failed:", err.message);
      res.clearCookie("refreshToken", cookieOptions);
      return res.status(401).json({
        error: "SESSION_INVALID",
        message: "Session expired or invalid"
      });
    }

    const { sub: userId, sid: sessionId } = payload;

    /* ---------------------------------------------------------
       2️⃣ Fetch EXACT session (no user-wide lookup)
    --------------------------------------------------------- */
    const sessionResult = await pool.query(
      `
      SELECT token_id, token_hash
      FROM refresh_tokens
      WHERE user_id = $1
        AND session_id = $2
        AND expires_at > now()
      `,
      [userId, sessionId]
    );

    if (sessionResult.rowCount === 0) {
      res.clearCookie("refreshToken", cookieOptions);
      return res.status(401).json({
        error: "SESSION_INVALID",
        message: "Session not found or terminated"
      });
    }

    const { token_id, token_hash } = sessionResult.rows[0];

    /* ---------------------------------------------------------
       3️⃣ Validate refresh token
    --------------------------------------------------------- */
    const isValid = await bcrypt.compare(refreshToken, token_hash);
    if (!isValid) {
      // Token reuse or tampering → kill this session immediately
      await pool.query(
        `DELETE FROM refresh_tokens WHERE session_id = $1`,
        [sessionId]
      );

      res.clearCookie("refreshToken", cookieOptions);
      return res.status(401).json({
        error: "SESSION_INVALID",
        message: "Security breach detected: session terminated"
      });
    }

    /* ---------------------------------------------------------
       4️⃣ Fetch roles
    --------------------------------------------------------- */
    const rolesResult = await pool.query(
      `
      SELECT r.role_name
      FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = $1
      `,
      [userId]
    );

    const roles = rolesResult.rows.map(r => r.role_name);

    // Fetch user status for onboarding check
    const userStatusResult = await pool.query(
      `SELECT is_onboarding_complete FROM users WHERE user_id = $1`,
      [userId]
    );
    const onboardingComplete = userStatusResult.rows[0]?.is_onboarding_complete || false;

    /* ---------------------------------------------------------
       5️⃣ Rotate tokens (UPDATE, not INSERT)
    --------------------------------------------------------- */
    const newAccessToken = signAccessToken({
      sub: userId,
      sid: sessionId,
      roles,
      onboarding_complete: onboardingComplete,
    });

    const newRefreshToken = signRefreshToken({
      sub: userId,
      sid: sessionId,
    });

    const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 12);

    await pool.query(
      `
      UPDATE refresh_tokens
      SET token_hash = $1,
          expires_at = now() + interval '7 days'
      WHERE session_id = $2
      `,
      [hashedNewRefreshToken, sessionId]
    );

    /* ---------------------------------------------------------
       6️⃣ Set refreshed cookie
    --------------------------------------------------------- */
    res.cookie("refreshToken", newRefreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    /* ---------------------------------------------------------
       7️⃣ Return new access token
    --------------------------------------------------------- */
    return res.status(200).json({
      accessToken: newAccessToken,
    });

  } catch (err) {
    console.error("Refresh token error:", err);
    res.clearCookie("refreshToken");
    return res.status(403).json({ message: "Invalid or expired refresh token" });
  }
};

exports.logout = async (req, res) => {
  console.log("🚪 [BE] Logout endpoint HIT");

  try {
    /* ---------------------------------------------------------
       1️⃣ Validate access token
    --------------------------------------------------------- */
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      console.warn("⚠️ [BE] Missing Authorization header");
      return res.status(401).json({ message: "Missing access token" });
    }

    const accessToken = authHeader.split(" ")[1];
    const { sub: userId, sid: sessionId } = verifyAccessToken(accessToken, {
      ignoreExpiration: true,
    });

    console.log("👤 [BE] Logout requested for user:", userId);

    /* ---------------------------------------------------------
       2️⃣ Delete EXACT session (no UA / IP guessing)
    --------------------------------------------------------- */
    const result = await pool.query(
      `
      DELETE FROM refresh_tokens
      WHERE user_id = $1
        AND session_id = $2
      RETURNING token_id
      `,
      [userId, sessionId]
    );

    if (result.rowCount === 0) {
      console.warn("⚠️ [BE] No session found (already logged out)");
    } else {
    }

    /* ---------------------------------------------------------
       3️⃣ Clear refresh cookie
    --------------------------------------------------------- */
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
    });

    console.log("✅ [BE] Logout completed");
    return res.status(200).json({ message: "Logged out successfully" });

  } catch (err) {
    console.error("❌ [BE] Logout error:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

exports.getMe = async (req, res) => {
  const userId = req.user.sub;

  try {
    // 1. Get User Data
    const userResult = await pool.query(
      `SELECT user_id AS id, email, full_name, is_onboarding_complete, account_name FROM users WHERE user_id = $1`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userResult.rows[0];
    user.roles = req.user.roles; // From token

    // 2. Get Profile Data
    const profileResult = await pool.query(
      `SELECT account_type AS "accountType", open_to AS "openTo", availability, work_preference AS "workPreference"
         FROM profiles
         WHERE user_id = $1`,
      [userId]
    );

    const profile = profileResult.rows[0] || {};

    res.json({
      user,
      profile
    });
  } catch (err) {
    console.error("GetMe error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
//const pool = require("../db/pool");

exports.getSessions = async (req, res) => {
  try {
    const userId = req.user.sub; // from access token
    const currentSessionId = req.user.sid; // from access token

    const result = await pool.query(
      `
      SELECT 
        session_id,
        user_agent,
        ip_address,
        created_at,
        expires_at
      FROM refresh_tokens
      WHERE user_id = $1
        AND expires_at > NOW()
        AND revoked = FALSE
      ORDER BY created_at DESC
      `,
      [userId]
    );

    const sessions = result.rows.map(row => {
      const parser = new UAParser(row.user_agent);
      const ua = parser.getResult();

      const browser = ua.browser.name || (row.user_agent.includes("axios") ? "Axios Client" : (row.user_agent.includes("node") ? "Node.js" : "Unknown Browser"));
      const os = ua.os.name || "Unknown OS";
      let deviceType = "Unknown";

      if (ua.device.type === "mobile") {
        deviceType = "Mobile";
      } else if (ua.device.type === "tablet") {
        deviceType = "Tablet";
      } else if (!ua.device.type) {
        // If it's a known non-browser client, mark as Service/API
        if (browser === "Axios Client" || browser === "Node.js" || row.user_agent.includes("Postman")) {
          deviceType = "Service/API";
        } else {
          deviceType = "Desktop";
        }
      }

      return {
        session_id: row.session_id,
        browser,
        os,
        device_type: deviceType,
        user_agent: row.user_agent,
        ip_address: row.ip_address,
        created_at: row.created_at,
        expires_at: row.expires_at,
        is_current: row.session_id === currentSessionId
      };
    });

    res.json({
      sessions
    });

  } catch (error) {
    console.error("Get sessions error:", error);
    res.status(500).json({
      message: "Unable to fetch active sessions"
    });
  }
};

exports.getMySessionCount = async (req, res) => {
  try {
    const userId = req.user.sub; // from access token

    const result = await pool.query(
      `
      SELECT COUNT(*) 
      FROM refresh_tokens
      WHERE user_id = $1
      AND expires_at > NOW()
      AND revoked = FALSE
      `,
      [userId]
    );

    res.json({
      my_session_count: Number(result.rows[0].count)
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Unable to fetch your session count"
    });
  }
};
exports.logoutAllOtherSessions = async (req, res) => {
  try {
    const userId = req.user.sub; // from access token
    const currentSessionId = req.user.sid; // from access token
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    // 1. Verify password
    const userResult = await pool.query(
      "SELECT password_hash FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isPasswordValid = await comparePassword(password, userResult.rows[0].password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const result = await pool.query(
      `
      DELETE FROM refresh_tokens
      WHERE user_id = $1
        AND session_id != $2
      RETURNING session_id
      `,
      [userId, currentSessionId]
    );

    res.json({
      message: "All other sessions terminated",
      deleted_count: result.rowCount
    });

  } catch (error) {
    console.error("Logout all other sessions error:", error);
    res.status(500).json({
      message: "Unable to terminate other sessions"
    });
  }
};

exports.removeSession = async (req, res) => {
  try {
    const userId = req.user.sub;      // from access token
    const { sessionId } = req.params; // session to remove
    const { password } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        message: "sessionId is required"
      });
    }

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    // 1. Verify password
    const userResult = await pool.query(
      "SELECT password_hash FROM users WHERE user_id = $1",
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isPasswordValid = await comparePassword(password, userResult.rows[0].password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const result = await pool.query(
      `
      DELETE FROM refresh_tokens
      WHERE user_id = $1
        AND session_id = $2
      RETURNING session_id
      `,
      [userId, sessionId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Session not found"
      });
    }

    return res.json({
      message: "Session removed successfully",
      removedSession: result.rows[0].session_id
    });

  } catch (err) {
    console.error("Remove session error:", err);
    res.status(500).json({
      message: "Failed to remove session"
    });
  }
};

