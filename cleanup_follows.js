require('dotenv').config();
const pool = require('./src/db/pool');

async function cleanup(email) {
    if (!email) {
        console.log("Usage: node cleanup_follows.js <email>");
        process.exit(1);
    }

    try {
        const userRes = await pool.query("SELECT user_id, full_name FROM users WHERE email = $1", [email]);
        if (userRes.rowCount === 0) {
            console.log(`User with email ${email} not found`);
            return;
        }

        const userId = userRes.rows[0].user_id;
        console.log(`Cleaning up follows for: ${userRes.rows[0].full_name} [${userId}]`);

        // 1. Remove all company follows
        const cfRes = await pool.query("DELETE FROM company_followers WHERE user_id = $1 RETURNING *", [userId]);
        console.log(`Removed ${cfRes.rowCount} company follows.`);

        // 2. Remove all user follows (that are NOT mutual connections - OPTIONAL)
        // For now, let's just remove ALL follows to allow a fresh start.
        const fRes = await pool.query("DELETE FROM followers WHERE follower_id = $1 RETURNING *", [userId]);
        console.log(`Removed ${fRes.rowCount} user follows.`);

        // 3. Reset company followers_count for relevant companies
        // (This is harder without knowing which ones were deleted, but we can do a global fix)
        console.log("Recalculating company follower counts...");
        await pool.query(`
      UPDATE companies c
      SET followers_count = (
        SELECT COUNT(*) FROM company_followers cf WHERE cf.company_id = c.company_id
      )
    `);
        console.log("Follower counts resynchronized.");

        console.log("Cleanup completed successfully.");

    } catch (err) {
        console.error("Cleanup failed:", err);
    } finally {
        process.exit(0);
    }
}

const targetEmail = process.argv[2];
cleanup(targetEmail);
