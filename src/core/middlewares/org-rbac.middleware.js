const pool = require("../db/pool");
const AppError = require("../errors/AppError");

function checkFeaturePermission(permissions, requiredKey) {
    if (!permissions || !Array.isArray(permissions)) return false;

    const upperPerms = permissions.map(p => String(p).toUpperCase().trim());
    const targetKey = String(requiredKey).toUpperCase().trim();

    if (upperPerms.includes('*') || upperPerms.includes('MANAGE_COMPANY') || upperPerms.includes(targetKey)) return true;

    // Channel fallback
    if (targetKey === 'CHANNELS' && upperPerms.includes('CHANNEL')) return true;
    if (targetKey === 'CHANNEL' && upperPerms.includes('CHANNELS')) return true;

    // Analytics fallback
    if (targetKey === 'VIEW_ANALYTICS' && upperPerms.includes('ANALYTICS')) return true;

    // JOBS parent implies sub-permissions
    const jobsSubPerms = ["POST_JOBS", "VIEW_APPLICANTS", "JOBS_CHAT", "JOBS"];
    if (jobsSubPerms.includes(targetKey) && upperPerms.includes("JOBS")) return true;

    // TEAMS parent implies sub-permissions
    const teamsSubPerms = ["VIEW_MEMBERS", "INVITE_MEMBERS", "REMOVE_MEMBERS", "MANAGE_MEMBERS", "MANAGE_ROLES", "TEAMS"];
    if (teamsSubPerms.includes(targetKey) && upperPerms.includes("TEAMS")) return true;

    // CHANNEL parent implies channel-related details
    const channelSubPerms = ["MANAGE_COMPANY_DETAILS", "INVITE_MEMBERS", "CHANNEL"];
    if (channelSubPerms.includes(targetKey) && upperPerms.includes("CHANNEL")) return true;

    // Sub-permission fallbacks
    if (targetKey === 'QUERIES' && upperPerms.includes('CHAT')) return true;
    if (targetKey === 'JOBS_CHAT' && upperPerms.includes('JOBS')) return true;

    return false;
}

const { getOrganizationMembership } = require("./actor-context.middleware");

const requireOrgAccess = (featureKey, isPublicRoute = false) => async (req, res, next) => {
    try {
        const userId = req.user?.sub;
        if (!userId) {
            return next(new AppError("User context is required.", 401));
        }

        const urlOrgId = req.params.orgId || req.params.companyId;

        // 1. Auto-resolve organization actor context if user is acting as USER but targeting a valid org where they are a member/owner
        if (!req.actor || req.actor.type !== 'ORGANIZATION') {
            if (!urlOrgId) {
                return next(new AppError("To access teams and RBAC routes, you must act as the organization.", 403));
            }

            const member = await getOrganizationMembership(urlOrgId, userId, pool);
            if (member && member.status === 'ACTIVE') {
                const rawPermissions = member.permissions || [];
                const permissions = (Array.isArray(rawPermissions) ? rawPermissions : [])
                    .map(p => String(p).toUpperCase().trim());

                req.actor = {
                    type: "ORGANIZATION",
                    id: urlOrgId,
                    userId,
                    orgId: urlOrgId,
                    roleId: member.role_id || null,
                    permissions,
                    roleName: member.role_name,
                    rolePriority: member.priority || 0,
                    source: "auto_resolved_url_access",
                };
            } else {
                // Check if user is created_by owner in organizations table
                const ownerRes = await pool.query(
                    "SELECT created_by FROM organizations WHERE org_id = $1",
                    [urlOrgId]
                );
                if (ownerRes.rowCount > 0 && ownerRes.rows[0].created_by === userId) {
                    req.actor = {
                        type: "ORGANIZATION",
                        id: urlOrgId,
                        userId,
                        orgId: urlOrgId,
                        roleId: null,
                        permissions: ["*"],
                        roleName: "Owner",
                        rolePriority: 100,
                        source: "auto_resolved_owner_access",
                    };
                } else {
                    return next(new AppError("To access teams and RBAC routes, you must be an active member or owner of the organization.", 403));
                }
            }
        }

        // 2. Ensure actor matches target organization in route
        if (urlOrgId && req.actor.orgId !== urlOrgId) {
            return next(new AppError("Active organization actor does not match the target organization", 403));
        }

        // 3. Retrieve the owner (created_by) from organizations table
        const orgRes = await pool.query(
            "SELECT created_by FROM organizations WHERE org_id = $1",
            [req.actor.orgId]
        );
        if (orgRes.rowCount === 0) {
            return next(new AppError("Organization not found", 404));
        }
        const ownerId = orgRes.rows[0].created_by;

        // 4. Check if owner is added as an active member in organization_members
        let ownerIsMember = false;
        if (ownerId) {
            const ownerMemberCheck = await pool.query(
                "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
                [req.actor.orgId, ownerId]
            );
            ownerIsMember = ownerMemberCheck.rowCount > 0;
        }

        // 5. Determine if user has valid access (is team member or owner)
        let hasValidAccess = false;
        if (ownerIsMember) {
            // Check if current user is an active member
            const userMemberCheck = await pool.query(
                "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
                [req.actor.orgId, userId]
            );
            hasValidAccess = userMemberCheck.rowCount > 0;
        } else {
            // Check if current user is the owner first, then decide
            if (userId === ownerId) {
                hasValidAccess = true;
            } else {
                // Otherwise check if current user is an active member
                const userMemberCheck = await pool.query(
                    "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
                    [req.actor.orgId, userId]
                );
                hasValidAccess = userMemberCheck.rowCount > 0;
            }
        }

        if (!hasValidAccess) {
            return next(new AppError("You are not a member of this organization", 403));
        }

        // 6. Log organization activity (COMMENTED OUT: Internal page view logging disabled; only public profile views and explicit actions are logged)
        /*
        const { logAudit } = require("../infrastructure/audit.service");
        logAudit(pool, {
            entityId: req.actor.orgId,
            actorId: req.actor.userId,
            actorRole: req.actor.roleName,
            action: isPublicRoute ? `VIEW_${featureKey}` : featureKey,
            metadata: {
                path: req.originalUrl,
                method: req.method,
                ip: req.ip,
                userAgent: req.headers['user-agent']
            }
        }).catch(err => console.error("Failed to log organization activity:", err));
        */

        // 7. If this is a public GET / open route, skip permission enforcement
        if (isPublicRoute) {
            return next();
        }

        const permissions = req.actor.permissions || [];

        // 8. Owner Bypass: check if owner first
        const isOwner = permissions.includes('*') || req.actor.roleName === 'Owner' || userId === ownerId;
        if (isOwner) {
            return next();
        }

        // 9. Admin Check: check if admin (has 'MANAGE_COMPANY' system permission), allow all
        const isAdmin = permissions.includes('MANAGE_COMPANY') || req.actor.roleName === 'Admin';
        if (isAdmin) {
            return next();
        }

        // 10. Role-Based Check: check specific feature permissions
        if (checkFeaturePermission(permissions, featureKey)) {
            return next();
        }

        return next(new AppError(`You don't have access to ${featureKey}. Ask your admin to update your role permissions.`, 403));
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    requireOrgAccess,
    checkFeaturePermission
};
