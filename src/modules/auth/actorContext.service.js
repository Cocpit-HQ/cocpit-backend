const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { COOKIE_OPTIONS } = require("./auth.service");

const ACTOR_CONTEXT_COOKIE_NAME = "activeActor";
const ACTOR_CONTEXT_COOKIE_OPTIONS = {
    ...COOKIE_OPTIONS,
    maxAge: 30 * 24 * 60 * 60 * 1000,
};

const parseActorCookie = (rawValue) => {
    if (!rawValue || typeof rawValue !== "string") return null;

    const [type, id] = rawValue.split(":");
    if (!type || !id) return null;
    if (type !== "USER" && type !== "ORGANIZATION") return null;

    return { type, id };
};

const canSwitchToOrganization = (organization) => {
    const isExpired = organization?.expires_at && new Date(organization.expires_at) < new Date();
    const isOwner = Boolean(organization?.viewer_role_data?.is_owner);
    const hasActiveRole = Boolean(organization?.role && !organization.role.includes('_deleted_'));
    return organization?.status === "ACTIVE" && !isExpired && (isOwner || hasActiveRole);
};

const buildOrganizationActor = (organization) => {
    let viewerRoleData = organization.viewer_role_data || null;
    if (viewerRoleData && Array.isArray(viewerRoleData.permissions)) {
        viewerRoleData = {
            ...viewerRoleData,
            permissions: viewerRoleData.permissions.map(p => String(p).toUpperCase().trim())
        };
    }

    return {
        type: "ORGANIZATION",
        id: organization.org_id || organization.company_id,
        slug: organization.slug,
        name: organization.name,
        avatar_url: organization.logo_url,
        entity_type: organization.entity_type,
        viewer_role_data: viewerRoleData,
        verification_status: organization.verification_status,
    };
};

const buildUserActor = (userId) => ({
    type: "USER",
    id: userId,
});

async function getOrganizationsForUser(userId) {
    const result = await pool.query(
        `SELECT c.*,
                cm.status,
                cm.expires_at,
                (SELECT COUNT(*) FROM organizations WHERE parent_org_id = c.org_id AND is_deleted = FALSE) as children_count,
                json_build_object(
                    'name', cr.name,
                    'description', cr.description,
                    'permissions', cr.permissions,
                    'priority', cr.priority,
                    'is_owner', (c.created_by = $1)
                ) as viewer_role_data,
                cr.name as role
         FROM organizations c
         JOIN organization_members cm ON c.org_id = cm.org_id
         LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
         WHERE cm.user_id = $1 
           AND c.is_deleted = FALSE 
           AND c.is_deactivated = FALSE 
           AND cm.status = 'ACTIVE'
           AND (c.created_by = $1 OR (cm.role_id IS NOT NULL AND cr.is_active = TRUE))
         ORDER BY c.created_at DESC`,
        [userId]
    );

    return result.rows.map((organization) => ({
        ...organization,
        company_id: organization.company_id || organization.org_id,
    }));
}

async function getActorContext(userId, rawActorCookie) {
    const organizations = await getOrganizationsForUser(userId);
    const parsedCookie = parseActorCookie(rawActorCookie);

    if (parsedCookie?.type === "ORGANIZATION") {
        const organization = organizations.find(
            (candidate) => (candidate.org_id || candidate.company_id) === parsedCookie.id
        );

        if (organization && canSwitchToOrganization(organization)) {
            return {
                actor: buildOrganizationActor(organization),
                organizations,
                source: "cookie",
                clearCookie: false,
            };
        }
    }

    return {
        actor: buildUserActor(userId),
        organizations,
        source: "default_user",
        clearCookie: Boolean(parsedCookie),
    };
}

async function setActorContext(userId, actorInput) {
    const organizations = await getOrganizationsForUser(userId);

    if (actorInput?.type === "USER") {
        return {
            actor: buildUserActor(userId),
            organizations,
            source: "explicit_user",
            cookieValue: null,
        };
    }

    if (actorInput?.type !== "ORGANIZATION" || !actorInput.id) {
        throw new AppError("Invalid actor selection", 400);
    }

    const organization = organizations.find(
        (candidate) => (candidate.org_id || candidate.company_id) === actorInput.id
    );

    if (!organization) {
        throw new AppError("Organization not found for current user", 403);
    }

    if (!canSwitchToOrganization(organization)) {
        throw new AppError("You do not have permission to act as this organization", 403);
    }

    return {
        actor: buildOrganizationActor(organization),
        organizations,
        source: "explicit_organization",
        cookieValue: `ORGANIZATION:${organization.org_id || organization.company_id}`,
    };
}

module.exports = {
    ACTOR_CONTEXT_COOKIE_NAME,
    ACTOR_CONTEXT_COOKIE_OPTIONS,
    getActorContext,
    setActorContext,
};
