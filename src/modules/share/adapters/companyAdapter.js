const pool = require("../../../core/db/pool");

/**
 * Company Adapter
 * Converts company entity to universal preview metadata.
 */
async function resolve(companyId) {
    const res = await pool.query(
        `SELECT company_id, name, logo_url, industry, slug, slogan
         FROM companies WHERE company_id = $1 AND is_deleted = FALSE`,
        [companyId]
    );
    if (res.rowCount === 0) return null;

    const c = res.rows[0];
    return {
        entityType: "company",
        entityId: companyId,
        title: c.name,
        subtitle: c.slogan || c.industry || "Company",
        image: c.logo_url,
        url: `/company/${c.slug || companyId}`,
    };
}

module.exports = { resolve };
