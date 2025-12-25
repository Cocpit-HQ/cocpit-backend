const pool = require("../db/pool");
const { hashPassword, comparePassword } = require("../utils/password");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");
const bcrypt = require("bcrypt");

exports.register = async (req, res) => {
  const { email, password, fullName } = req.body;

  try {
    // 1. Check if user exists
    const exists = await pool.query(
      "SELECT 1 FROM users WHERE email = $1",
      [email]
    );

    if (exists.rowCount > 0) {
      return res.status(409).json({ message: "Email already registered" });
    }

    // 2. Hash password
    const passwordHash = await hashPassword(password);

    // 3. Create user
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING user_id, email, full_name`,
      [email, passwordHash, fullName]
    );

    const user = userResult.rows[0];

    // 4. Assign default role
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, role_id FROM roles WHERE role_name = 'User'`,
      [user.user_id]
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
      return res.status(401).json({ message: "Invalid credentials" });
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

    // OPTIONAL but recommended: clear old refresh tokens
    await pool.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [user.user_id]
    );

    await pool.query(
      `
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, now() + interval '7 days')
      `,
      [user.user_id, hashedRefresh]
    );

    res.status(200).json({
      accessToken,
      refreshToken, // later → httpOnly cookie
      user: {
        id: user.user_id,
        email: user.email,
        roles,
      },
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
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token missing" });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);

    const userId = payload.sub;

    // Check for token reuse
    // This is a simplified check. In a real-world scenario, you'd want to
    // check against a list of used tokens or have a more robust mechanism.
    const tokenInDb = await pool.query(
      `SELECT token_hash FROM refresh_tokens WHERE user_id = $1`,
      [userId]
    );

    let tokenIsValid = false;
    for (const row of tokenInDb.rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) {
        tokenIsValid = true;
        break;
      }
    }

    if (!tokenIsValid) {
      // If the token is not in the DB, it might have been stolen and used.
      // For security, we invalidate all refresh tokens for this user.
      await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    // Fetch roles
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

    // Issue new tokens
    const newAccessToken = signAccessToken({ sub: userId, roles });
    const newRefreshToken = signRefreshToken({ sub: userId });
    const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 12);

    // Delete old token
    await pool.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [userId]
    );

    // Store new token
    await pool.query(
      `
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, now() + interval '7 days')
      `,
      [userId, hashedNewRefreshToken]
    );

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    console.error("Refresh token error:", err);
    if (err.code === '28P01') {
      return res.status(500).json({ error: "Database authentication failed. Please check your database credentials." });
    }
    // If the token is invalid or expired, jwt.verify will throw an error
    return res.status(403).json({ message: "Invalid or expired refresh token" });
  }
};
