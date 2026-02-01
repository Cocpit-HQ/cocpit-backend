require("dotenv").config();
const pool = require("./src/db/pool");
const { buildJobFilters } = require("./src/utils/jobQueryBuilder");

async function run() {
    const userId = "5bd67106-a349-4705-bbef-e6fae7497a02";
    const status = "applied";
    // The suspected bug: Default UI sends "All Levels", matching literally.
    const reqQuery = { status, experienceLevel: "All Levels" };

    try {
        console.log("--- Simulating getMyApplications ---");

        const { conditions, values, nextIndex } = buildJobFilters(reqQuery, 2);
        const params = [userId, ...values];
        let paramCount = nextIndex;

        let baseQuery = `
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        LEFT JOIN users u ON j.recruiter_id = u.user_id
        LEFT JOIN job_saves js ON j.job_id = js.job_id AND js.user_id = $1
        WHERE ja.applicant_id = $1
    `;

        if (conditions.length > 0) {
            baseQuery += ` AND ${conditions.join(" AND ")}`;
        }

        if (status) {
            const s = status.toLowerCase();
            if (s === 'in past' || s === 'in-past') {
                baseQuery += ` AND j.is_active = false`;
            } else if (s === 'applied') {
                baseQuery += ` AND j.is_active = TRUE AND ja.current_status != 'Rejected'`;
            }
        }

        const query = `
        SELECT j.title, ja.current_status, j.is_active, j.experience_level
        ${baseQuery}
        ORDER BY ja.applied_at DESC
    `;

        console.log("Query:", query);
        console.log("Params:", params);

        const result = await pool.query(query, params);

        console.log("--- Results ---");
        result.rows.forEach(r => {
            console.log(`- [${r.current_status}] ${r.title} (Active: ${r.is_active}) [Exp: ${r.experience_level}]`);
        });

    } catch (err) {
        console.error("Error:", err);
    } finally {
        process.exit();
    }
}

run();
