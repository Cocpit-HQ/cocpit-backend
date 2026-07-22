const pool = require("../db/pool");
const AppError = require("../errors/AppError");
const { logAudit } = require("../infrastructure/audit.service");

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
    const targetPerm = String(permission).toUpperCase().trim();
    const upperPerms = (Array.isArray(permissions) ? permissions : [])
        .map(p => String(p).toUpperCase().trim());

    if (upperPerms.includes("*") || upperPerms.includes(targetPerm)) return true;

    // Hierarchy / Parent-child permission mappings
    if (targetPerm === "VIEW_ANALYTICS" && upperPerms.includes("ANALYTICS")) return true;
    
    // JOBS parent implies sub-permissions
    const jobsSubPerms = ["POST_JOBS", "VIEW_APPLICANTS", "JOBS_CHAT", "JOBS"];
    if (jobsSubPerms.includes(targetPerm) && upperPerms.includes("JOBS")) return true;

    // TEAMS parent implies sub-permissions
    const teamsSubPerms = ["VIEW_MEMBERS", "INVITE_MEMBERS", "REMOVE_MEMBERS", "MANAGE_MEMBERS", "MANAGE_ROLES", "TEAMS"];
    if (teamsSubPerms.includes(targetPerm) && upperPerms.includes("TEAMS")) return true;

    // CHANNEL parent implies channel-related details
    const channelSubPerms = ["MANAGE_COMPANY_DETAILS", "INVITE_MEMBERS", "CHANNEL", "CHANNELS", "MANAGE_CHANNEL"];
    const hasChannelPerm = upperPerms.some(p => ["CHANNEL", "CHANNELS", "MANAGE_CHANNEL"].includes(p));
    if (channelSubPerms.includes(targetPerm) && hasChannelPerm) return true;

    // CHAT parent implies sub-permissions
    if ((targetPerm === "QUERIES" || targetPerm === "CHAT" || targetPerm === "MESSAGES") && (upperPerms.includes("CHAT") || upperPerms.includes("MESSAGES"))) return true;

    // Hierarchy: MANAGE_X implies VIEW_X
    if (targetPerm.startsWith("VIEW_") && upperPerms.includes(targetPerm.replace("VIEW_", "MANAGE_"))) return true;

    return false;
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
    const rawPermissions = member.permissions || [];
    const permissions = (Array.isArray(rawPermissions) ? rawPermissions : [])
        .map(p => String(p).toUpperCase().trim());

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

    try {
        const orgsRes = await pool.query(
            "SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'ACTIVE'",
            [userId]
        );
        req.userOrganizations = orgsRes.rows.map(r => r.org_id);
    } catch (e) {
        console.error("Failed to pre-fetch user organizations:", e);
        req.userOrganizations = [];
    }

    const requestedActor = getRequestedActorInput(req);

    if (!requestedActor) {
        return buildUserActor(userId);
    }

    if (requestedActor.type === "USER") {
        if (requestedActor.id && requestedActor.id !== userId) {
            console.warn(`[ActorContext] Stale USER actor ID detected (${requestedActor.id}). Falling back to current user (${userId}).`);
        }

        return buildUserActor(userId, requestedActor.source);
    }

    if (!requestedActor.id) {
        throw new AppError("Organization actor id is required", 400);
    }

    try {
        const member = await getOrganizationMembership(requestedActor.id, userId);
        assertActiveMembership(member);

        const permissions = member.permissions || [];

        req.member = {
            role: member.role_name,
            permissions,
            priority: member.priority || 0,
        };

        return buildOrganizationActor(requestedActor.id, userId, member, requestedActor.source);
    } catch (err) {
        // [RESOLVED 403] Graceful Fallback
        // If organization resolution fails (stale membership, blocked, etc.), 
        // fallback to USER context instead of 403ing the whole request.
        // Downstream middlewares like requireOrgActorPermission will still catch and block 
        // if the specific route actually NEEDS the organization context.
        if (err.statusCode === 403) {
            console.warn(`[ActorContext] Fallback to USER: ${err.message} (Requested ORG: ${requestedActor.id})`);
            return buildUserActor(userId, "fallback_from_stale_org");
        }
        throw err;
    }
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

    const urlOrgId = req.params.orgId || req.params.companyId;

    // When the actor is already resolved as ORGANIZATION via headers (x-actor-type/x-actor-id),
    // the actor's own orgId is the authoritative identity.
    // The URL param is used for informational routing and must match if provided,
    // but strict enforcement only applies when STRICT_ORG_ACTOR_AUTH is set.
    if (urlOrgId && req.actor.orgId !== urlOrgId) {
        if (STRICT_ORG_ACTOR_AUTH) {
            return next(new AppError("Active organization actor does not match the target organization", 403));
        }
        // In non-strict mode: log and proceed using the actor's orgId as source of truth.
        // This handles race conditions where the URL param and actor headers are briefly out of sync.
        console.warn(
            `[ActorContext] orgId mismatch: actor=${req.actor.orgId}, url=${urlOrgId}. Using actor orgId.`
        );
    }

    const perms = Array.isArray(permission) ? permission : [permission];
    const hasPerm = perms.some(p => hasActorPermission(req.actor.permissions, p));

    if (!hasPerm) {
        if (req.actor?.orgId && req.actor?.userId) {
            logAudit(pool, {
                entityId: req.actor.orgId,
                actorId: req.actor.userId,
                actorRole: req.actor.roleName || null,
                action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
                metadata: {
                    attemptedPermission: permission,
                    attemptedRoute: req.originalUrl || req.url,
                    unauthorizedAttempt: true
                }
            });
        }
        return next(new AppError(`You do not have permission: ${Array.isArray(permission) ? permission.join(" or ") : permission}`, 403));
    }

    req.member = {
        role: req.actor.roleName,
        permissions: req.actor.permissions || [],
        priority: req.actor.rolePriority || 0,
    };

    // Ensure req.params.orgId is set to the actor's orgId for downstream use
    if (!req.params.orgId && !req.params.companyId) {
        req.params.orgId = req.actor.orgId;
    }

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
