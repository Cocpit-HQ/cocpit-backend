const pool = require("../db/pool");
const AppError = require("../errors/AppError");

// Status constants
const MEMBER_STATUS = {
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED',
    PENDING_INVITE: 'PENDING_INVITE',
    REMOVED: 'REMOVED'
};

/**
 * Middleware to check if user has specific permission.
 * Now improved to check:
 * 1. Membership existence
 * 2. Account Status (Must be ACTIVE)
 * 3. Account Expiry (Must not be expired)
 * 4. Permission existence
 */
const requireCompanyPermission = (permission) => async (req, res, next) => {
    const client = await pool.connect();
    try {
        const { companyId } = req.params;
        const userId = req.user.sub;

        if (!companyId) return next(new AppError("Company ID missing", 400));

        // Get Member details joined with Role details
        // Note: Joining on (company_id, role_name) because legacy schema uses role name string
        const query = `
            SELECT 
                cm.status, 
                cm.expires_at,
                cr.name as role_name,
                cr.permissions,
                cr.priority
            FROM company_members cm
            LEFT JOIN company_roles cr ON cm.role_id = cr.role_id
            WHERE cm.company_id = $1 AND cm.user_id = $2
        `;

        const result = await client.query(query, [companyId, userId]);

        if (result.rowCount === 0) {
            return next(new AppError("You are not a member of this company", 403));
        }

        const member = result.rows[0];

        // 1. Status Check
        if (member.status !== MEMBER_STATUS.ACTIVE) {
            return next(new AppError(`Access denied. Your account status is: ${member.status}`, 403));
        }

        // 2. Expiry Check
        if (member.expires_at && new Date(member.expires_at) < new Date()) {
            return next(new AppError("Access denied. Your role has expired.", 403));
        }

        // 3. Permission Check
        const permissions = member.permissions || [];
        const hasPermission = permissions.includes("*") ||
            permissions.includes(permission) ||
            (permission.startsWith("VIEW_") && permissions.includes(permission.replace("VIEW_", "MANAGE_")));

        if (!hasPermission) {
            return next(new AppError(`You do not have permission: ${permission}`, 403));
        }

        // Attach context
        req.member = {
            role: member.role_name,
            permissions: permissions,
            priority: member.priority || 0
        };

        next();

    } catch (err) {
        next(err);
    } finally {
        client.release();
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

module.exports = {
    requireCompanyPermission,
    requireRolePriority
};
