const pool = require("../../../core/db/pool");

/**
 * Job Adapter
 * Converts job entity to universal preview metadata.
 */
async function resolve(jobId) {
    const res = await pool.query(
        `SELECT job_id, title, company_name, location
         FROM jobs WHERE job_id = $1`,
        [jobId]
    );
    if (res.rowCount === 0) return null;

    const j = res.rows[0];
    return {
        entityType: "job",
        entityId: jobId,
        title: j.title,
        subtitle: `${j.company_name}${j.location ? ` · ${j.location}` : ""}`,
        image: null,
        url: `/jobs/${jobId}`,
    };
}

module.exports = { resolve };
