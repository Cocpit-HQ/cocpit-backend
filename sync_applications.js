const pool = require('./src/core/db/pool');

async function sync() {
  try {
    const res = await pool.query(`
      SELECT user_id, job_id, applied_at 
      FROM applications 
      WHERE NOT EXISTS (
        SELECT 1 FROM user_activity_log 
        WHERE user_activity_log.user_id = applications.user_id 
          AND user_activity_log.entity_id = applications.job_id::varchar
          AND user_activity_log.action_type = 'apply_job'
      )
    `);
    
    console.log(`Found ${res.rowCount} applications missing from activity log.`);
    
    for (const app of res.rows) {
      await pool.query(`
        INSERT INTO user_activity_log (user_id, action_type, entity_type, entity_id, created_at)
        VALUES ($1, 'apply_job', 'job', $2, $3)
      `, [app.user_id, app.job_id, app.applied_at]);
    }
    
    console.log('Sync complete.');
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

sync();
