const pool = require("../db/pool");
const { hashPassword, comparePassword } = require("../utils/password");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");
const bcrypt = require("bcrypt");
const { use } = require("../app");

exports.register = async (req, res) => {
  const { email, password, fullName, accountType } = req.body;

  try {
    // 1. Check if user exists
    const exists = await pool.query(
      "SELECT 1 FROM users WHERE email = $1",
      [email]
    );

    if (exists.rowCount > 0) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const passwordHash = await hashPassword(password);
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING user_id, email, full_name`,
      [email, passwordHash, fullName]
    );

    const user = userResult.rows[0];

    const roleName = accountType === 'Admin' ? 'Admin' : 'User';

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, role_id FROM roles WHERE role_name = $2`,
      [user.user_id, roleName]
    );

    // 5. Create profile with accountType
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

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = email.toLowerCase();
  try {
    const userResult = await pool.query(
      `
      SELECT user_id, email, password_hash
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return res.status(401).json({ message: "user not found" });
    }

    const user = userResult.rows[0];

    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Fetch roles
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

    // Generate tokens
    const accessToken = signAccessToken({
      sub: user.user_id,
      roles,
    });

    const refreshToken = signRefreshToken({
      sub: user.user_id,
    });
    const hashedRefresh = await bcrypt.hash(refreshToken, 12);

    const MAX_DEVICES = 2;
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip;

    await pool.query("BEGIN");

    try {

      const existingDevice = await pool.query(
        `SELECT token_id
    FROM refresh_tokens
    WHERE user_id = $1
      AND user_agent = $2
      AND ip_address = $3
      AND expires_at > now()`,
        [user.user_id, userAgent, ipAddress]
      );

      if (existingDevice.rowCount > 0) {
        //  Same device login → UPDATE token
        await pool.query(
          ` UPDATE refresh_tokens
      SET token_hash = $1,
          expires_at = now() + interval '7 days',
          created_at = now()
      WHERE token_id = $2`,
          [hashedRefresh, existingDevice.rows[0].token_id]
        );
      }
      else {
        //  Count active sessions
        const { rows } = await pool.query(
          ` SELECT COUNT(*)::int AS count
    FROM refresh_tokens
    WHERE user_id = $1
      AND revoked = FALSE
      AND expires_at > now() `,
          [user.user_id]
        );

        const activeDevices = rows[0].count;
        //  Revoke oldest session IF limit exceeded
        if (activeDevices >= MAX_DEVICES) {
          await pool.query(
            `delete from refresh_tokens where  token_id = (
        SELECT token_id
        FROM refresh_tokens
        WHERE user_id = $1
          AND revoked = FALSE
          AND expires_at > now()
        ORDER BY created_at ASC
        LIMIT 1 ) `,
            [user.user_id]
          );
        }

        //   Insert new refresh token (new device)
        await pool.query(
          `INSERT INTO refresh_tokens
    (user_id, token_hash, expires_at, user_agent, ip_address)
    VALUES ($1, $2, now() + interval '7 days', $3, $4)
    `, [user.user_id, hashedRefresh, userAgent, ipAddress]
        );
      }

      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    // Set Refresh Token in HTTP-only cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(200).json({
      "accessToken": accessToken,
      "refreshToken": refreshToken,
      user: {
        "id": user.user_id,
        "email": user.email,
        "fullName": user.full_name,
        "roles": roles,
        "userAgent": userAgent,
        "ipAddress": ipAddress

      }
    });
  } catch (err) {
    console.error("Login error:", err);
    if (err.code === '28P01') {
      return res.status(500).json({ error: "Database authentication failed. Please check your database credentials." });
    }
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.refreshToken = async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token missing" });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const userId = payload.sub;
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip;

    //  Fetch stored token for SAME device
    const tokenResult = await pool.query(
      `  SELECT token_id, token_hash
      FROM refresh_tokens
      WHERE user_id = $1
        AND user_agent = $2
        AND ip_address = $3
        AND expires_at > now()
      `, [userId, userAgent, ipAddress]
    );

    if (tokenResult.rowCount === 0) {
      res.clearCookie("refreshToken");
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    const { token_id, token_hash } = tokenResult.rows[0];
    //  Compare hashed token
    const isValid = await bcrypt.compare(refreshToken, token_hash);
    if (!isValid) {
      await pool.query(
        `DELETE FROM refresh_tokens
        WHERE token_id = $1`,
        [token_id]
      );

      res.clearCookie("refreshToken");
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    //  Fetch roles
    const rolesResult = await pool.query(
      ` SELECT r.role_name
      FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = $1
      `, [userId]
    );
    const roles = rolesResult.rows.map(r => r.role_name);

    //  Generate new tokens
    const newAccessToken = signAccessToken({
      sub: userId,
      roles,
    });
    const newRefreshToken = signRefreshToken({
      sub: userId,
    });
    const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 12);

    //  Rotate refresh token for SAME device (UPDATE, not DELETE)
    await pool.query(
      `UPDATE refresh_tokens
      SET token_hash = $1,
          expires_at = now() + interval '7 days',
          created_at = now()
      WHERE token_id = $2
      `, [hashedNewRefreshToken, token_id]
    );

    // Set new refresh token cookie
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });

  } catch (err) {
    console.error("Refresh token error:", err);
    res.clearCookie("refreshToken");
    return res.status(403).json({ message: "Invalid or expired refresh token" });
  }
};


exports.logout = async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(200).json({ message: "already Logged out " })
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const userId = payload.sub;
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip;

    //  Fetch stored token for SAME device
    const tokenResult = await pool.query(
      `  SELECT token_id, token_hash
      FROM refresh_tokens
      WHERE user_id = $1
        AND user_agent = $2
        AND ip_address = $3
        AND expires_at > now()
      `, [userId, userAgent, ipAddress]
    );

    if (tokenResult.rowCount === 0) {
      res.clearCookie("refreshToken");
      return res.status(200).json({ message: "Logged out" });
    }

    const { token_id, token_hash } = tokenResult.rows[0];

    const isValid = await bcrypt.compare(refreshToken, token_hash);
    if (isValid) {
      await pool.query(
        `DELETE FROM refresh_tokens WHERE token_id = $1`,
        [token_id]
      );
    }

  } catch (e) {
    res.status(500).json({ message: "Internal server error" });
  }

  res.clearCookie('refreshToken');
  res.status(200).json({ message: "Logged out successfully" });
};

exports.getMe = async (req, res) => {
  const userId = req.user.sub;

  try {
    // 1. Get User Data
    const userResult = await pool.query(
      `SELECT user_id AS id, email, full_name FROM users WHERE user_id = $1`,
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
