const pool = require('../../../core/db/pool');
const { logAdminActivity } = require('../../utils/auditLogger');

// Basic UUID check
const isUUID = (str) => {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return regex.test(str);
};

exports.globalSearch = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters long' });
    }

    const searchQuery = q.trim();
    let users = [];
    let organizations = [];

    if (isUUID(searchQuery)) {
      // Search by exact UUID
      const userResult = await pool.query(
        'SELECT user_id, full_name, email, avatar_url, job_title FROM users WHERE user_id = $1',
        [searchQuery]
      );
      users = userResult.rows;

      const orgResult = await pool.query(
        'SELECT org_id, name, slug, logo_url, industry, verification_status FROM organizations WHERE org_id = $1',
        [searchQuery]
      );
      organizations = orgResult.rows;
    } else {
      // Search by text (ILIKE)
      const ilikeQuery = `%${searchQuery}%`;
      
      const userResult = await pool.query(
        `SELECT user_id, full_name, email, avatar_url, job_title 
         FROM users 
         WHERE full_name ILIKE $1 OR email ILIKE $1 
         ORDER BY full_name ASC 
         LIMIT 10`,
        [ilikeQuery]
      );
      users = userResult.rows;

      const orgResult = await pool.query(
        `SELECT org_id, name, slug, logo_url, industry, verification_status 
         FROM organizations 
         WHERE name ILIKE $1 OR slug ILIKE $1 
         ORDER BY name ASC 
         LIMIT 10`,
        [ilikeQuery]
      );
      organizations = orgResult.rows;
    }

    res.json({
      users,
      organizations
    });
  } catch (err) {
    console.error('[Admin] Global Search Error:', err);
    res.status(500).json({ error: 'Internal server error during search' });
  }
};