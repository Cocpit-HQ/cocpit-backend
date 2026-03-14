const pool = require("../db/pool");
const AppError = require("../errors/AppError");

const MEMBER_STATUS = {
    ACTIVE: "ACTIVE",
};

const STRICT_ORG_ACTOR_AUTH = process.env.STRICT_ORG_ACTOR_AUTH === "true";

const normalizeActorType = (rawType) => {
    if (!rawType || typeof rawType !== "string") return null;

    const normalized = rawType.trim().toUpperCase();
    if (normalized === "COMPANY") return "ORGANIZATION";
    if (normalized === "ORG") return "ORGANIZATION";
    if (normalized === "ORGANIZATION" || normalized === "USER") return normalized;
    return null;
};

const getRequestedActorInput = (req) => {
    const canonicalType = normalizeActorType(req.headers["x-actor-type"]);
    const canonicalId = req.headers["x-actor-id"];

    if (canonicalType) {
        return {
            type: canonicalType,
            id: typeof canonicalId === "string" ? canonicalId : null,
            source: "canonical_header",
            explicit: true,
        };
    }

    return null;
};

const hasActorPermission = (permissions = [], permission) => {
    if (!permission) return true;

    return permissions.includes("*") ||
        permissions.includes(permission) ||
        (permission.startsWith("VIEW_") && permissions.includes(permission.replace("VIEW_", "MANAGE_")));
};

async function getOrganizationMembership(orgId, userId, queryable = pool) {
    const result = await queryable.query(
        `SELECT
            cm.org_id,
            cm.user_id,
            cm.role_id,
            cm.status,
            cm.expires_at,
            cr.name AS role_name,
            cr.permissions,
            cr.priority
         FROM organization_members cm
         LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
         WHERE cm.org_id = $1 AND cm.user_id = $2`,
        [orgId, userId]
    );

    if (result.rowCount === 0) return null;
    return result.rows[0];
}

function assertActiveMembership(member) {
    if (!member) {
        throw new AppError("You are not a member of this organization", 403);
    }

    if (member.status !== MEMBER_STATUS.ACTIVE) {
        throw new AppError(`Access denied. Your account status is: ${member.status}`, 403);
    }

    if (member.expires_at && new Date(member.expires_at) < new Date()) {
        throw new AppError("Access denied. Your role has expired.", 403);
    }
}

function buildUserActor(userId, source = "default_user") {
    return {
        type: "USER",
        id: userId,
        userId,
        source,
    };
}

function buildOrganizationActor(orgId, userId, member, source) {
    const permissions = member.permissions || [];

    return {
        type: "ORGANIZATION",
        id: orgId,
        userId,
        orgId,
        roleId: member.role_id || null,
        permissions,
        roleName: member.role_name,
        rolePriority: member.priority || 0,
        source,
    };
}

async function resolveActorContextForRequest(req) {
    if (!req.user?.sub) return null;

    const userId = req.user.sub;
    const requestedActor = getRequestedActorInput(req);

    if (!requestedActor) {
        return buildUserActor(userId);
    }

    if (requestedActor.type === "USER") {
        if (requestedActor.id && requestedActor.id !== userId) {
            throw new AppError("Invalid user actor context", 403);
        }

        return buildUserActor(userId, requestedActor.source);
    }

    if (!requestedActor.id) {
        throw new AppError("Organization actor id is required", 400);
    }

    const member = await getOrganizationMembership(requestedActor.id, userId);
    assertActiveMembership(member);

    const permissions = member.permissions || [];
    if (!permissions.includes("*") && !permissions.includes("SWITCH_TO_COMPANY")) {
        throw new AppError("You do not have permission to act as this organization", 403);
    }

    req.member = {
        role: member.role_name,
        permissions,
        priority: member.priority || 0,
    };

    return buildOrganizationActor(requestedActor.id, userId, member, requestedActor.source);
}

const resolveActorContext = async (req, res, next) => {
    try {
        req.actor = await resolveActorContextForRequest(req);
        next();
    } catch (err) {
        next(err);
    }
};

const requireActorType = (type) => (req, res, next) => {
    if (!req.actor || req.actor.type !== type) {
        return next(new AppError(`This action requires actor type ${type}`, 403));
    }

    next();
};

const requireOrgActorPermission = (permission) => (req, res, next) => {
    if (!req.actor || req.actor.type !== "ORGANIZATION") {
        return next(new AppError("This action requires organization actor context", 403));
    }

    const targetOrgId = req.params.orgId || req.params.companyId || req.actor.orgId;
    if (!targetOrgId) {
        return next(new AppError("Organization ID missing", 400));
    }

    if ((STRICT_ORG_ACTOR_AUTH || req.params.orgId || req.params.companyId) && req.actor.orgId !== targetOrgId) {
        return next(new AppError("Active organization actor does not match the target organization", 403));
    }

    if (!hasActorPermission(req.actor.permissions, permission)) {
        return next(new AppError(`You do not have permission: ${permission}`, 403));
    }

    req.member = {
        role: req.actor.roleName,
        permissions: req.actor.permissions || [],
        priority: req.actor.rolePriority || 0,
    };

    next();
};

module.exports = {
    getRequestedActorInput,
    getOrganizationMembership,
    hasActorPermission,
    assertActiveMembership,
    resolveActorContextForRequest,
    resolveActorContext,
    requireActorType,
    requireOrgActorPermission,
};
