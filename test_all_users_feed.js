require('dotenv').config();
const pool = require('./src/core/db/pool');
const feedService = require('./src/modules/feed/feed.service');

(async () => {
  try {
    const usersRes = await pool.query('SELECT user_id, full_name FROM users LIMIT 10');
    console.log(Testing feed for  users...);
    
    for (const u of usersRes.rows) {
      try {
        await feedService.getFeed({
          userId: u.user_id,
          cursor: null,
          limit: 20,
          pool,
          context: 'home',
          orgActorId: undefined,
          algorithm: true
        });
        console.log(? User  (): Feed OK);
      } catch (err) {
        console.error(? User  (): ERROR:, err.message);
        console.error(err.stack);
      }
    }

    const orgsRes = await pool.query('SELECT org_id, name, created_by FROM organizations WHERE is_deleted = false LIMIT 5');
    console.log(\nTesting org actor feed for  orgs...);
    for (const o of orgsRes.rows) {
      try {
        await feedService.getFeed({
          userId: o.created_by || usersRes.rows[0].user_id,
          cursor: null,
          limit: 20,
          pool,
          context: 'home',
          orgActorId: o.org_id,
          algorithm: true
        });
        console.log(? Org  (): Feed OK);
      } catch (err) {
        console.error(? Org  (): ERROR:, err.message);
        console.error(err.stack);
      }
    }

  } catch (err) {
    console.error('Fatal test error:', err);
  } finally {
    process.exit(0);
  }
})();
