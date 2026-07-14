const db = require('../../../core/db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { logAdminActivity } = require('../../utils/auditLogger');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return generic error for enumeration prevention, but log exact issues internally if needed
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userResult = await db.query('SELECT * FROM admin_panel_users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userRoles = [user.role];
    const allowedRoles = ['Admin', 'Moderator', 'Developer'];
    const hasAccess = userRoles.some(role => allowedRoles.includes(role));

    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied. Authorized personnel only.' });
    }

    const payload = { userId: user.id, roles: userRoles };
    
    const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '24h' });

    const sessionId = crypto.randomUUID();
    const tokenHash = hashToken(refreshToken);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';

    await db.query(
      `INSERT INTO admin_refresh_tokens (admin_user_id, session_id, token_hash, expires_at, user_agent, ip_address) 
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', $4, $5)`,
      [user.id, sessionId, tokenHash, userAgent, ipAddress]
    );

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({
      message: 'Login successful',
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        roles: userRoles
      }
    });

    // Fire-and-forget audit log
    logAdminActivity(user.id, 'LOGIN', 'Successful administrator login', ipAddress);

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const refresh = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token provided' });

  try {
    const tokenHash = hashToken(refreshToken);
    const dbTokenResult = await db.query('SELECT * FROM admin_refresh_tokens WHERE token_hash = $1', [tokenHash]);
    
    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    const dbToken = dbTokenResult.rows[0];

    // Token Reuse Detection
    if (dbToken.revoked) {
      console.warn(`Token reuse detected for admin user ${dbToken.admin_user_id}. Revoking all tokens.`);
      await db.query('UPDATE admin_refresh_tokens SET revoked = true WHERE admin_user_id = $1', [dbToken.admin_user_id]);
      return res.status(403).json({ error: 'Security alert: Token reuse detected. All sessions revoked.' });
    }

    jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
      if (err) return res.status(403).json({ error: 'Token expired or invalid' });

      const payload = { userId: decoded.userId, roles: decoded.roles };
      const newAccessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
      res.json({ accessToken: newAccessToken, roles: decoded.roles });
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const logout = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) return res.status(204).send();

  try {
    const tokenHash = hashToken(refreshToken);
    
    // Get admin_user_id for logging before revocation
    const dbTokenResult = await db.query('SELECT admin_user_id FROM admin_refresh_tokens WHERE token_hash = $1', [tokenHash]);
    const userId = dbTokenResult.rows[0]?.admin_user_id;

    await db.query('UPDATE admin_refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
    res.clearCookie('refreshToken', { httpOnly: true, sameSite: 'strict' });
    res.status(200).json({ message: 'Logged out successfully' });

    if (userId) {
      logAdminActivity(userId, 'LOGOUT', 'Administrator logged out successfully');
    }
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { login, refresh, logout };
