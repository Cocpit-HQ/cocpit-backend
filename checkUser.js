require("dotenv").config();
const pool = require("c:/Users/user2/Desktop/test/cocpit-backend/src/core/db/pool");

async function checkUser() {
  try {
    const res = await pool.query("SELECT * FROM profiles WHERE profile_id = '226a55e7-0158-4d0f-8d14-fa8d8e85bba5'");
    console.log("Profile:", res.rows[0]);
    
    const userRes = await pool.query("SELECT * FROM active_users WHERE user_id = $1", [res.rows[0].user_id]);
    console.log("User:", userRes.rows[0].account_name);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkUser();
