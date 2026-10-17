// Consolidated Permissions List
const PERMISSIONS = {
    // Company Management
    MANAGE_COMPANY_DETAILS: 'MANAGE_COMPANY_DETAILS', // Edit name, logo, tech stack
    MANAGE_SETTINGS: 'MANAGE_SETTINGS', // Danger zone, domain, billing (Owner only usually)

    // Team Management
    VIEW_MEMBERS: 'VIEW_MEMBERS',
    INVITE_MEMBERS: 'INVITE_MEMBERS',
    REMOVE_MEMBERS: 'REMOVE_MEMBERS',
    MANAGE_ROLES: 'MANAGE_ROLES', // Create/Edit roles, Assign roles

    // Talent & Jobs
    POST_JOBS: 'POST_JOBS',
    VIEW_APPLICANTS: 'VIEW_APPLICANTS',
    MANAGE_APPLICANTS: 'MANAGE_APPLICANTS', // Move stages, hire/reject

    // Content & Social
    CREATE_CONTENT: 'CREATE_CONTENT',
    MANAGE_COMMENTS: 'MANAGE_COMMENTS', // Moderate comments
    MANAGE_OWN_CONTENT: 'MANAGE_OWN_CONTENT', // Derived permission (not always stored, but logic check)

    // Analytics
    VIEW_ANALYTICS: 'VIEW_ANALYTICS',
};

// System Roles Defaults (for reference or initialization)
const SYSTEM_ROLES = {
    OWNER: {
        permissions: ['*'], // Wildcard for everything
        priority: 100
    },
    ADMIN: {
        permissions: [
            PERMISSIONS.MANAGE_COMPANY_DETAILS,
            PERMISSIONS.VIEW_MEMBERS,
            PERMISSIONS.INVITE_MEMBERS,
            PERMISSIONS.REMOVE_MEMBERS,
            PERMISSIONS.MANAGE_ROLES,
            PERMISSIONS.POST_JOBS,
            PERMISSIONS.VIEW_APPLICANTS,
            PERMISSIONS.MANAGE_APPLICANTS,
            PERMISSIONS.CREATE_CONTENT,
            PERMISSIONS.MANAGE_COMMENTS,
            PERMISSIONS.VIEW_ANALYTICS
        ],
        priority: 90
    },
    RECRUITER: {
        permissions: [
            PERMISSIONS.POST_JOBS,
            PERMISSIONS.VIEW_APPLICANTS,
            PERMISSIONS.MANAGE_APPLICANTS,
            PERMISSIONS.VIEW_ANALYTICS
        ],
        priority: 50
    },
    EDITOR: {
        permissions: [
            PERMISSIONS.MANAGE_COMPANY_DETAILS,
            PERMISSIONS.CREATE_CONTENT,
            PERMISSIONS.MANAGE_COMMENTS,
            PERMISSIONS.VIEW_ANALYTICS
        ],
        priority: 50
    },
    MEMBER: {
        permissions: [
            PERMISSIONS.VIEW_MEMBERS
        ],
        priority: 10
    },
    INTERN: {
        permissions: [], // No access to dashboard
        priority: 0
    }
};

module.exports = {
    PERMISSIONS,
    SYSTEM_ROLES
};
