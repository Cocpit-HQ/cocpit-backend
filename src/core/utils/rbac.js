const pool = require("../db/pool");

/**
 * Maps legacy company permissions to organization permissions
 */
const PERMISSION_MAP = {
    'MANAGE_COMPANY': 'MANAGE_ORGANIZATION',
    'MANAGE_COMPANY_DETAILS': 'MANAGE_ORGANIZATION_DETAILS',
    'VIEW_COMPANY_CHATS': 'VIEW_ORGANIZATION_CHATS',
    'MANAGE_COMPANY_CHATS': 'MANAGE_ORGANIZATION_CHATS',
    'SWITCH_TO_COMPANY': 'SWITCH_TO_ORGANIZATION'
};

/**
 * Check if a user has specific permissions within an organization (company or institution).
 * @param {Object} queryable - The database client or pool to execute the query.
 * @param {string} orgId - The ID of the organization.
 * @param {string} userId - The ID of the user.
 * @param {string|string[]} permissionsToCheck - A single permission string or an array of permissions.
 * @returns {Promise<boolean>} - True if authorized, false otherwise.
 */
const checkOrgPermission = async (queryable, orgId, userId, permissionsToCheck) => {
    try {
        const res = await queryable.query(
            `SELECT cr.permissions, cr.name, cm.status, cm.expires_at
             FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2`,
            [orgId, userId]
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
        return checks.some(p => {
            // Check original
            if (perms.includes(p)) return true;

            // Check organization mapping
            const mapped = PERMISSION_MAP[p];
            if (mapped && perms.includes(mapped)) return true;

            // Check if p is an organization permission and has a legacy mapping in perms
            const legacy = Object.keys(PERMISSION_MAP).find(k => PERMISSION_MAP[k] === p);
            if (legacy && perms.includes(legacy)) return true;

            // JOBS parent implies sub-permissions
            const jobsSubPerms = ["POST_JOBS", "VIEW_APPLICANTS", "MANAGE_APPLICANTS", "JOBS_CHAT", "JOBS", "MANAGE_JOBS", "VIEW_JOBS"];
            const hasAnyJobPerm = perms.some(perm => ["JOBS", "POST_JOBS", "MANAGE_APPLICANTS", "MANAGE_JOBS"].includes(perm));
            if (jobsSubPerms.includes(p) && hasAnyJobPerm) return true;

            // Hierarchy: MANAGE_X implies VIEW_X
            if (p.startsWith("VIEW_") && perms.includes(p.replace("VIEW_", "MANAGE_"))) return true;

            // Cross-mapping hierarchy (VIEW_ORG -> MANAGE_COMPANY, etc)
            if (p.startsWith("VIEW_")) {
                const manageP = p.replace("VIEW_", "MANAGE_");
                const manageMapped = PERMISSION_MAP[manageP];
                if (manageMapped && perms.includes(manageMapped)) return true;
                const manageLegacy = Object.keys(PERMISSION_MAP).find(k => PERMISSION_MAP[k] === manageP);
                if (manageLegacy && perms.includes(manageLegacy)) return true;
            }

            return false;
        });

    } catch (err) {
        console.error("RBAC Check Error:", err);
        return false;
    }
};

// Backward compatibility alias
const checkCompanyPermission = checkOrgPermission;

module.exports = {
    checkOrgPermission,
    checkCompanyPermission // Legacy alias — will be removed after full migration
};
