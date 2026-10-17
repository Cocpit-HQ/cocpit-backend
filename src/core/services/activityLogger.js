const pool = require("../db/pool");

const logActivity = async (userId, actionType, entityType, entityId = null, metadata = {}) => {
  try {
    // 💡 Activity Deduplication / Upsert Logic
    // We deduplicate high-frequency actions (like searching or viewing the same job repeatedly) 
    // to keep the activity feed clean.
    if (actionType === 'search_job' || actionType === 'view_job') {
      const entityCheck = actionType === 'view_job' ? "AND entity_id = $3" : "";
      const params = actionType === 'view_job' ? [userId, actionType, entityId] : [userId, actionType];

      const recentRes = await pool.query(
        `SELECT id FROM user_activity_log 
         WHERE user_id = $1 AND action_type = $2 ${entityCheck}
         AND created_at > NOW() - INTERVAL '60 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        params
      );

      if (recentRes.rowCount > 0) {
        await pool.query(
          "UPDATE user_activity_log SET metadata = $1, created_at = NOW() WHERE id = $2",
          [metadata, recentRes.rows[0].id]
        );
        return;
      }
    }

    // Standard Insert for new or non-debounced actions
    await pool.query(
      `
      INSERT INTO user_activity_log (user_id, action_type, entity_type, entity_id, metadata)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [userId, actionType, entityType, entityId, metadata]
    );

  } catch (err) {
    console.error("Activity Log Error:", err.message);
  }
};


const removeActivity = async (userId, actionType, entityId) => {
  try {
    await pool.query(
      `DELETE FROM user_activity_log 
       WHERE user_id = $1 AND action_type = $2 AND entity_id = $3`,
      [userId, actionType, entityId]
    );
  } catch (err) {
    console.error("Activity Remove Error:", err.message);
  }
};

module.exports = { logActivity, removeActivity };
