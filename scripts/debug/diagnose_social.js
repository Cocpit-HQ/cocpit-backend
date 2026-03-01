require('dotenv').config();
const pool = require('./src/db/pool');

async function diagnose() {
    const name = 'Swaroop';
    try {
        const userRes = await pool.query("SELECT user_id, full_name, email FROM users WHERE full_name ILIKE $1", [`%${name}%`]);
        if (userRes.rowCount === 0) {
            console.log(`User ${name} not found`);
            return;
        }

        for (const user of userRes.rows) {
            const userId = user.user_id;
            console.log(`\n--- Diagnosing User: ${user.full_name} (${user.email}) [${userId}] ---`);

            // 1. Check Following (Users)
            const followingUsers = await pool.query(`
        SELECT u.full_name, f.created_at 
        FROM followers f 
        JOIN users u ON f.following_id = u.user_id 
        WHERE f.follower_id = $1
      `, [userId]);
            console.log(`Following (Users) [${followingUsers.rowCount}]:`, followingUsers.rows);

            // 2. Check Followers (Users)
            const followersUsers = await pool.query(`
        SELECT u.full_name, f.created_at 
        FROM followers f 
        JOIN users u ON f.follower_id = u.user_id 
        WHERE f.following_id = $1
      `, [userId]);
            console.log(`Followers (Users) [${followersUsers.rowCount}]:`, followersUsers.rows);

            // 3. Check Following (Companies)
            const followingCompanies = await pool.query(`
        SELECT c.name, cf.created_at 
        FROM company_followers cf 
        JOIN companies c ON cf.company_id = c.company_id 
        WHERE cf.user_id = $1
      `, [userId]);
            console.log(`Following (Companies) [${followingCompanies.rowCount}]:`, followingCompanies.rows);

            // 4. Check Connections (Users)
            const connectionsUsers = await pool.query(`
        SELECT u.full_name, c.created_at 
        FROM connections c 
        JOIN users u ON c.connected_user_id = u.user_id 
        WHERE c.user_id = $1
      `, [userId]);
            console.log(`Connections (Users) [${connectionsUsers.rowCount}]:`, connectionsUsers.rows);

            // 5. Check Connections (Companies)
            const connectionsCompanies = await pool.query(`
        SELECT c.name, cc.created_at 
        FROM company_connections cc 
        JOIN companies c ON cc.company_id = c.company_id 
        WHERE cc.user_id = $1
      `, [userId]);
            console.log(`Connections (Companies) [${connectionsCompanies.rowCount}]:`, connectionsCompanies.rows);
        }

    } catch (err) {
        console.error("Diagnosis failed:", err);
    } finally {
        process.exit(0);
    }
}

diagnose();
