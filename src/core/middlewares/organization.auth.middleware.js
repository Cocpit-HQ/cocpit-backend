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
        const orgId = req.params.orgId || req.params.companyId;
        if (!orgId) return next(new AppError("Organization ID missing", 400));
        if (req.actor?.type === "ORGANIZATION") {
            return requireOrgActorPermission(permission)(req, res, next);
        }

        const member = await getOrganizationMembership(orgId, req.user.sub, pool);
        assertActiveMembership(member);

        const permissions = member.permissions || [];
        if (!hasActorPermission(permissions, permission)) {
            return next(new AppError(`You do not have registration permission: ${permission} in this organization`, 403));
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
