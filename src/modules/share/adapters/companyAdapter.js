const pool = require("../../../core/db/pool");

/**
 * Company Adapter
 * Converts company entity to universal preview metadata.
 */
async function resolve(companyId) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId);
    const query = isUuid
        ? `SELECT org_id as company_id, name, logo_url, industry, slug, slogan FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`
        : `SELECT org_id as company_id, name, logo_url, industry, slug, slogan FROM organizations WHERE slug = $1 AND is_deleted = FALSE`;

    const res = await pool.query(query, [companyId]);
    if (res.rowCount === 0) return null;

    const c = res.rows[0];
    return {
        entityType: "company",
        entityId: c.company_id,
        title: c.name,
        subtitle: c.slogan || c.industry || "Company",
        image: c.logo_url,
        url: `/organization/${c.slug || c.company_id}`,
    };
}

module.exports = { resolve };
