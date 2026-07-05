const pool = require("../core/db/pool");

/**
 * Resolves organization ID for experiences on name/ID basis.
 * If matched, inserts/upserts the user into organization_members.
 */
async function handleExperienceOrgLink(client, userId, data) {
    let orgId = data.org_id;
    const companyName = data.company_name;

    if (!orgId && companyName) {
        // Query organizations table case-insensitively
        const orgRes = await client.query(
            `SELECT org_id FROM organizations 
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) 
               AND entity_type = 'COMPANY' 
               AND is_deleted = FALSE 
             LIMIT 1`,
            [companyName]
        );
        if (orgRes.rowCount > 0) {
            orgId = orgRes.rows[0].org_id;
            data.org_id = orgId;
        }
    }

    if (orgId) {
        // Find a default role (lowest priority role) to satisfy NOT NULL constraint
        let roleId = null;
        const roleRes = await client.query(
            `SELECT role_id FROM organization_roles 
             WHERE org_id = $1 
             ORDER BY priority ASC 
             LIMIT 1`,
            [orgId]
        );
        if (roleRes.rowCount > 0) {
            roleId = roleRes.rows[0].role_id;
        }

        if (roleId) {
            // Add member relation if not already a member (status set to ACTIVE, set is_core_team = TRUE and title)
            await client.query(
                `INSERT INTO organization_members (org_id, user_id, role_id, status, is_core_team, title)
                 VALUES ($1, $2, $3, 'ACTIVE', TRUE, $4)
                 ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'ACTIVE', is_core_team = TRUE, title = EXCLUDED.title`,
                [orgId, userId, roleId, data.title || null]
            );
        }
    }
}

/**
 * Resolves school organization ID for educations on name/ID basis.
 * If matched, inserts/upserts the user into organization_members (e.g. as Student role).
 */
async function handleEducationOrgLink(client, userId, data) {
    let schoolOrgId = data.school_org_id;
    const schoolName = data.school_name;

    if (!schoolOrgId && schoolName) {
        // Query organizations table case-insensitively
        const orgRes = await client.query(
            `SELECT org_id FROM organizations 
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) 
               AND entity_type = 'INSTITUTION' 
               AND is_deleted = FALSE 
             LIMIT 1`,
            [schoolName]
        );
        if (orgRes.rowCount > 0) {
            schoolOrgId = orgRes.rows[0].org_id;
            data.school_org_id = schoolOrgId;
        }
    }

    if (schoolOrgId) {
        // Find role_id for Student, or fallback to lowest priority role
        let roleId = null;
        const studentRole = await client.query(
            `SELECT role_id FROM organization_roles 
             WHERE org_id = $1 AND name ILIKE 'Student' 
             LIMIT 1`,
            [schoolOrgId]
        );
        if (studentRole.rowCount > 0) {
            roleId = studentRole.rows[0].role_id;
        } else {
            const fallbackRole = await client.query(
                `SELECT role_id FROM organization_roles 
                 WHERE org_id = $1 
                 ORDER BY priority ASC 
                 LIMIT 1`,
                [schoolOrgId]
            );
            if (fallbackRole.rowCount > 0) {
                roleId = fallbackRole.rows[0].role_id;
            }
        }

        if (roleId) {
            await client.query(
                `INSERT INTO organization_members (org_id, user_id, role_id, status)
                 VALUES ($1, $2, $3, 'ACTIVE')
                 ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'ACTIVE'`,
                [schoolOrgId, userId, roleId]
            );
        }
    }
}

/**
 * Checks if the user has any remaining current experiences at previous organizations.
 * If not, sets their membership status to 'REMOVED' (except for Owner/Admin roles).
 */
async function cleanupPreviousCompanyMemberships(client, userId, prevOrgIds) {
    const orgs = [...new Set(prevOrgIds.filter(Boolean))];
    if (orgs.length === 0) return;

    for (const orgId of orgs) {
        // Check if there are any remaining current/active experiences at this company
        const checkRes = await client.query(
            `SELECT 1 FROM experiences e
             JOIN profiles p ON e.profile_id = p.profile_id
             WHERE p.user_id = $1
               AND e.org_id = $2
               AND (e.is_current = true OR e.end_date IS NULL)
             LIMIT 1`,
            [userId, orgId]
        );

        if (checkRes.rowCount === 0) {
            // No remaining active experiences, set status to REMOVED (unless Owner/Admin)
            await client.query(
                `UPDATE organization_members om
                 SET status = 'REMOVED', updated_at = NOW()
                 WHERE om.user_id = $1
                   AND om.org_id = $2
                   AND om.status = 'ACTIVE'
                   AND EXISTS (
                       SELECT 1 FROM organization_roles r 
                       WHERE r.role_id = om.role_id 
                         AND r.name NOT IN ('Owner', 'Admin')
                   )`,
                [userId, orgId]
            );
        }
    }
}

module.exports = {
    handleExperienceOrgLink,
    handleEducationOrgLink,
    cleanupPreviousCompanyMemberships
};
