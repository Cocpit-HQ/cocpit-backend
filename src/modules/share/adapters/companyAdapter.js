const pool = require("../../../core/db/pool");

/**
 * Company Adapter
 * Converts company entity to universal preview metadata.
 */
async function resolve(companyId) {
    const res = await pool.query(
        `SELECT org_id as company_id, name, logo_url, industry, slug, slogan
         FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
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
        url: `/organization/${c.slug || companyId}`,
    };
}

module.exports = { resolve };
