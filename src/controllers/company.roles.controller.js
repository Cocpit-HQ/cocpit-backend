const pool = require("../db/pool");
const AppError = require("../utils/AppError");
const { logAudit } = require("../services/audit.service");

// Get all roles for a company
// Get all roles for a company
exports.getCompanyRoles = async (req, res, next) => {
    const { companyId } = req.params;
    const userId = req.user.sub; // Ensure we have the user

    const client = await pool.connect();
    try {
        // Enforce membership check (Any member can see roles)
        const memberCheck = await client.query(
            `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, userId]
        );
        if (memberCheck.rowCount === 0) {
            return res.status(403).json({ message: "Forbidden: Must be a company member" });
        }

        const result = await client.query(
            `SELECT * FROM company_roles WHERE company_id = $1 ORDER BY priority DESC`,
            [companyId]
        );

        res.json(result.rows);
    } catch (err) {
        next(err);
    } finally {
        client.release();
    }
};

// Create a new role
exports.createCompanyRole = async (req, res, next) => {
    const { companyId } = req.params;
    const { name, color, permissions, priority } = req.body;

    // Validation
    if (!name) return next(new AppError("Role name is required", 400));

    const client = await pool.connect();
    try {
        // Enforce basic hierarchy: Cannot create role higher than self
        const query = `
            SELECT cr.priority 
            FROM company_members cm 
            JOIN company_roles cr ON cm.role_id = cr.role_id 
            WHERE cm.company_id = $1 AND cm.user_id = $2
        `;
        const actorRes = await client.query(query, [companyId, req.user.sub]);
        const actorPriority = actorRes.rows[0]?.priority || 0;

        if ((priority || 0) >= actorPriority) {
            // Exception: Owner (100) can create other 100s? No, usually 1 owner.
            // Let's stick to strict: cannot create equal or higher.
            // Actually, if I am Admin (90), I should be able to create other Admnin roles (90) maybe?
            // But safer to say < actorPriority.
            // If Owner (100) creates Admin (90), that's fine.
            // If Owner (100) creates Co-Owner (100)?
            // Let's allow strictly LOWER for now unless we need peers.
            // If I am Admin, I can clone the Admin role? 
            // Let's use strict < for safety.
            if (priority >= actorPriority) {
                return next(new AppError("You cannot create a role with priority equal or higher than your own.", 403));
            }
        }

        // Enforce uniqueness of name per company
        const existing = await client.query(
            `SELECT 1 FROM company_roles WHERE company_id = $1 AND name ILIKE $2`,
            [companyId, name]
        );

        if (existing.rowCount > 0) {
            return next(new AppError("A role with this name already exists", 400));
        }

        const result = await client.query(
            `INSERT INTO company_roles (company_id, name, color, permissions, priority)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [companyId, name, color || '#808080', JSON.stringify(permissions || []), priority || 0]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    } finally {
        client.release();
    }
};

// Update a role
exports.updateCompanyRole = async (req, res, next) => {
    const { companyId, roleId } = req.params;
    const { name, color, permissions, priority } = req.body;
    const actorId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Get Actor's Role Priority
        const actorRes = await client.query(
            `SELECT cr.priority 
             FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id 
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, actorId]
        );
        const actorPriority = actorRes.rows[0]?.priority || 0;

        // 2. Get Target Role Details
        const roleCheck = await client.query(
            `SELECT * FROM company_roles WHERE role_id = $1 AND company_id = $2`,
            [roleId, companyId]
        );

        if (roleCheck.rowCount === 0) throw new AppError("Role not found", 404);
        const targetRole = roleCheck.rows[0];

        // 3. Hierarchy Check
        if (targetRole.priority >= actorPriority) {
            throw new AppError("Basic Hierarchy: You cannot modify a role with equal or higher priority than your own.", 403);
        }

        // 4. System Role Protections
        if (targetRole.is_system_role) {
            if (name && name !== targetRole.name) throw new AppError("Cannot change name of system roles", 400);
            if (priority && priority !== targetRole.priority) throw new AppError("Cannot change priority of system roles", 400);

            if (targetRole.name === 'Owner') {
                if (permissions) throw new AppError("Cannot modify Owner permissions", 400);
            }
        }

        // 5. Update
        const result = await client.query(
            `UPDATE company_roles 
             SET name = COALESCE($1, name),
                 color = COALESCE($2, color),
                 permissions = COALESCE($3, permissions),
                 priority = COALESCE($4, priority),
                 updated_at = NOW()
             WHERE role_id = $5 AND company_id = $6
             RETURNING *`,
            [name, color, JSON.stringify(permissions), priority, roleId, companyId]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: actorId,
            action: 'UPDATE_ROLE',
            metadata: { roleId, updates: { name, priority, permissions } }
        });

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
};

// Delete a role
exports.deleteCompanyRole = async (req, res, next) => {
    const { companyId, roleId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check system role
        const roleCheck = await client.query(
            `SELECT is_system_role, name FROM company_roles WHERE role_id = $1 AND company_id = $2`,
            [roleId, companyId]
        );

        if (roleCheck.rowCount === 0) throw new AppError("Role not found", 404);
        if (roleCheck.rows[0].is_system_role) {
            throw new AppError("Cannot delete system roles (Owner, Admin, etc.)", 400);
        }

        // Handle members with this role
        // Option 1: Prevent delete if members exist
        const memberCount = await client.query(
            `SELECT COUNT(*) FROM company_members WHERE role_id = $1`,
            [roleId]
        );

        if (parseInt(memberCount.rows[0].count) > 0) {
            throw new AppError("Cannot delete role assigned to members. Please reassign them first.", 400);
        }

        await client.query(`DELETE FROM company_roles WHERE role_id = $1`, [roleId]);

        await logAudit(client, {
            entityId: companyId,
            actorId: req.user.sub,
            action: 'DELETE_ROLE',
            metadata: { roleId }
        });

        await client.query('COMMIT');
        res.status(204).send(); // No Content

    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
};

// Assign role to member
exports.assignRoleToMember = async (req, res, next) => {
    const { companyId, userId } = req.params;
    const { roleId } = req.body;
    const actorId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Get Actor's Role & Priority
        const actorRes = await client.query(
            `SELECT cr.priority, cr.name 
             FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id 
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, actorId]
        );
        if (actorRes.rowCount === 0) throw new AppError("You are not a member of this company", 403);
        const actorRole = actorRes.rows[0];

        // 2. Get Target Member's Current Role & Priority
        const targetRes = await client.query(
            `SELECT cr.priority, cr.name
             FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id 
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );
        if (targetRes.rowCount === 0) throw new AppError("Member not found", 404);
        const targetRole = targetRes.rows[0];

        // 3. Get New Role Details
        const newRoleRes = await client.query(
            `SELECT priority, name, is_system_role FROM company_roles WHERE role_id = $1 AND company_id = $2`,
            [roleId, companyId]
        );
        if (newRoleRes.rowCount === 0) throw new AppError("Invalid role", 400);
        const newRole = newRoleRes.rows[0];

        // 4. Hierarchy Checks
        // Rule A: Cannot modify someone with Higher or Equal priority (unless you are Owner and they are Admin? No, simple strict hierarchy: Actor > Target)
        // Exception: If you are the Owner (System Role Owner, priority 100), you can modify other priority 100? No, there is only one Owner.
        // So Actor > Target is sufficient.
        if (actorRole.priority <= targetRole.priority) {
            throw new AppError("You cannot modify the role of a member with equal or higher authority.", 403);
        }

        // Rule B: Cannot promote someone to a role Higher than yourself
        // You can promote to Equal? No, usually cannot create a peer. Actor > NewRole.
        // Let's stick to Actor > NewRole to prevent an Admin making another Admin who could then rogue.
        // Actually, typically Admins CAN make other Admins. 
        // Discord: You can assign roles BELOW your highest role.
        // Let's say Actor > NewRole (Strict) or Actor >= NewRole (Loose).
        // If Actor(90) makes New(90), then New(90) can't touch Actor(90), but they are peers.
        // Let's go with Actor >= NewRole, giving peers power. 
        // WAIT, if I am Admin, can I make someone else Admin? Yes.
        // But if I make them Admin, I can't demote them later (Rule A). That's a risk the user takes.
        // Let's allow Actor >= NewRole.
        if (actorRole.priority < newRole.priority) {
            throw new AppError("You cannot assign a role with higher authority than your own.", 403);
        }

        // Rule C: Cannot assign "Owner" role manually
        if (newRole.name === 'Owner' && newRole.is_system_role) {
            throw new AppError("The 'Owner' role cannot be assigned manually. Use 'Transfer Ownership' instead.", 400);
        }

        // 5. Update Record
        await client.query(
            `UPDATE company_members 
             SET role_id = $1, joined_at = joined_at 
             WHERE company_id = $2 AND user_id = $3`,
            [roleId, companyId, userId]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: actorId,
            action: 'ASSIGN_ROLE',
            metadata: { targetUserId: userId, newRoleId: roleId, newRoleName: newRole.name }
        });

        await client.query('COMMIT');

        // Return updated details
        res.json({
            message: "Role updated successfully",
            role: newRole
        });

    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
};

// Update member role settings (Self-service: set primary, toggle visibility)
exports.updateMemberRoleSettings = async (req, res, next) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { is_primary_display, is_role_visible } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check verification (ensure user is actually a member)
        const memberCheck = await client.query(
            `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, userId]
        );

        if (memberCheck.rowCount === 0) {
            throw new AppError("You are not a member of this company", 403);
        }

        // Handle Primary Display Logic
        if (is_primary_display === true) {
            // Unset primary for all other roles of this user
            await client.query(
                `UPDATE company_members SET is_primary_display = FALSE WHERE user_id = $1`,
                [userId]
            );
        }

        // Update the specific record
        const query = `
            UPDATE company_members 
            SET 
                is_primary_display = COALESCE($1, is_primary_display),
                is_role_visible = COALESCE($2, is_role_visible)
            WHERE company_id = $3 AND user_id = $4
            RETURNING *
        `;

        const result = await client.query(query, [is_primary_display, is_role_visible, companyId, userId]);

        await client.query('COMMIT');
        res.json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
};
