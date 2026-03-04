const pool = require("../db/pool");

/**
 * Check if a user has specific permissions within a company.
 * @param {Object} queryable - The database client or pool to execute the query.
 * @param {string} companyId - The ID of the company.
 * @param {string} userId - The ID of the user.
 * @param {string|string[]} permissionsToCheck - A single permission string or an array of permissions.
 * @returns {Promise<boolean>} - True if authorized, false otherwise.
 */
const checkCompanyPermission = async (queryable, companyId, userId, permissionsToCheck) => {
    try {
        const res = await queryable.query(
            `SELECT cr.permissions, cr.name, cm.status, cm.expires_at
             FROM company_members cm
             LEFT JOIN company_roles cr ON cm.role_id = cr.role_id
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );

        if (res.rowCount === 0) return false;

        const { permissions, status, expires_at } = res.rows[0];

        if (status !== 'ACTIVE') return false;
        if (expires_at && new Date(expires_at) < new Date()) return false;

        // Permissions check
        const perms = permissions || [];
        if (perms.includes("*")) return true;

        const checks = Array.isArray(permissionsToCheck) ? permissionsToCheck : [permissionsToCheck];

        // Check if ANY of the required permissions are present
        // (Logic: If checking multiple, usually we want AT LEAST ONE, e.g. "MANAGE_COMPANY" OR "CREATE_CONTENT")
        return checks.some(p => {
            if (perms.includes(p)) return true;
            // Hierarchy: MANAGE_X implies VIEW_X
            if (p.startsWith("VIEW_") && perms.includes(p.replace("VIEW_", "MANAGE_"))) return true;
            return false;
        });

    } catch (err) {
        console.error("RBAC Check Error:", err);
        return false;
    }
};

module.exports = {
    checkCompanyPermission
};
