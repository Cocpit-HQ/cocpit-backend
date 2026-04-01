const pool = require("./src/core/db/pool");
const profileRepo = require("./src/modules/profile/profile.repository");

async function checkSkills() {
    try {
        const skillsResult = await pool.query("SELECT * FROM skills");
        console.log("ALL SKILLS:", skillsResult.rows);

        const profilesResult = await pool.query("SELECT * FROM profiles");
        console.log("PROFILES:", profilesResult.rows);

        const userSkillsResult = await pool.query("SELECT * FROM user_skills");
        console.log("USER SKILLS:", userSkillsResult.rows);
    } catch (err) {
        console.error("DEBUG ERROR:", err);
    } finally {
        pool.end();
    }
}

checkSkills();
