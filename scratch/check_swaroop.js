require("dotenv").config();
const pool = require("../src/core/db/pool");

async function checkSwaroop() {
    try {
        const userRes = await pool.query("SELECT * FROM users WHERE email = $1", ["swaroopmanade@gmail.com"]);
        if (userRes.rowCount === 0) {
            console.log("User swaroopmanade@gmail.com not found!");
            process.exit(0);
        }
        const user = userRes.rows[0];
        console.log("User details:", {
            user_id: user.user_id,
            email: user.email,
            full_name: user.full_name
        });

        const memberRes = await pool.query(
            `SELECT om.*, o.name AS org_name 
             FROM organization_members om 
             JOIN organizations o ON om.org_id = o.org_id 
             WHERE om.user_id = $1`,
            [user.user_id]
        );
        console.log("Organization memberships:", memberRes.rows.map(row => ({
            org_id: row.org_id,
            org_name: row.org_name,
            status: row.status,
            role_id: row.role_id
        })));

        process.exit(0);
    } catch (err) {
        console.error("Error checking Swaroop's data:", err);
        process.exit(1);
    }
}

checkSwaroop();
