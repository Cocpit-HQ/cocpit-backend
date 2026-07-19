const pool = require("../db/pool");
const AppError = require("../errors/AppError");

function checkFeaturePermission(permissions, requiredKey) {
    if (!permissions || !Array.isArray(permissions)) return false;

    // Owner wildcard
    if (permissions.includes('*')) return true;

    // Admin system key: MANAGE_COMPANY grants everything
    if (permissions.includes('MANAGE_COMPANY')) return true;

    // Exact match
    if (permissions.includes(requiredKey)) return true;

    // Sub-permission fallbacks
    if (requiredKey === 'QUERIES' && permissions.includes('CHAT')) return true;
    if (requiredKey === 'JOBS_CHAT' && permissions.includes('JOBS')) return true;

    return false;
}

const requireOrgAccess = (featureKey, isPublicRoute = false) => async (req, res, next) => {
    // 1. If not acting as ORGANIZATION actor type, skip check completely
    if (!req.actor || req.actor.type !== 'ORGANIZATION') {
        return next();
    }

    // 2. Ensure actor org ID matches route target org ID
    const urlOrgId = req.params.orgId || req.params.companyId;
    if (urlOrgId && req.actor.orgId !== urlOrgId) {
        return next(new AppError("Active organization actor does not match the target organization", 403));
    }

    // 3. Log organization activity (since actor is ORGANIZATION type)
    // Fire-and-forget logging
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

    // 4. If this is a public GET / open route, skip permission enforcement
    if (isPublicRoute) {
        return next();
    }

    const permissions = req.actor.permissions || [];

    // 5. Owner Bypass
    const isOwner = permissions.includes('*') || req.actor.roleName === 'Owner';
    if (isOwner) {
        return next();
    }

    // 6. Feature Check
    if (checkFeaturePermission(permissions, featureKey)) {
        return next();
    }

    return next(new AppError(`You don't have access to ${featureKey}. Ask your admin to update your role permissions.`, 403));
};

module.exports = {
    requireOrgAccess,
    checkFeaturePermission
};
