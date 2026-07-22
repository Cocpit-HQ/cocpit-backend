const pool = require("../db/pool");
const AppError = require("../errors/AppError");
const {
    getOrganizationMembership,
    assertActiveMembership,
    hasActorPermission,
    requireOrgActorPermission,
} = require("./actor-context.middleware");

/**
 * Middleware to check if user has specific permission within an organization.
 * Accepts both :orgId and :companyId route params for backward compatibility.
 * Checks:
 * 1. Membership existence
 * 2. Account Status (Must be ACTIVE)
 * 3. Account Expiry (Must not be expired)
 * 4. Permission existence
 */
const requireOrgPermission = (permission) => async (req, res, next) => {
    try {
        let orgId = req.params.orgId || req.params.companyId;
        if (!orgId) return next(new AppError("Organization ID missing", 400));

        // Fallback: If client mistakenly sends user ID instead of organization ID,
        // resolve it to their active organization ID.
        if (req.user && orgId === req.user.sub) {
            const userOrgs = await pool.query(
                "SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
                [req.user.sub]
            );
            if (userOrgs.rowCount > 0) {
                orgId = userOrgs.rows[0].org_id;
                if (req.params.orgId) req.params.orgId = orgId;
                if (req.params.companyId) req.params.companyId = orgId;
            }
        }

        if (req.actor?.type === "ORGANIZATION") {
            return requireOrgActorPermission(permission)(req, res, next);
        }

        const member = await getOrganizationMembership(orgId, req.user.sub, pool);
        assertActiveMembership(member);

        const permissions = member.permissions || [];
        const permsToCheck = Array.isArray(permission) ? permission : [permission];
        const hasPerm = permsToCheck.some(p => hasActorPermission(permissions, p));
        if (!hasPerm) {
            return next(new AppError(`You do not have permission: ${Array.isArray(permission) ? permission.join(" or ") : permission} in this organization`, 403));
        }

        req.member = {
            role: member.role_name,
            permissions,
            priority: member.priority || 0
        };

        if (!req.actor) {
            req.actor = {
                type: "USER",
                id: req.user.sub,
                userId: req.user.sub,
                source: "default_user",
            };
        }

        next();

    } catch (err) {
        next(err);
    }
};

/**
 * Middleware: Requires the user to have a role priority >= logic
 * Useful for "Role Escalation" protection.
 */
const requireRolePriority = (minPriority) => (req, res, next) => {
    if (!req.member || req.member.priority < minPriority) {
        return next(new AppError("Your role priority is too low for this action", 403));
    }
    next();
};

// Backward compatibility alias
const requireCompanyPermission = requireOrgPermission;

module.exports = {
    requireOrgPermission,
    requireCompanyPermission, // Legacy alias
    requireRolePriority,
    requireOrgActorPermission,
};
