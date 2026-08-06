'use strict';

const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { logAudit } = require("../../core/infrastructure/audit.service");
const socketService = require("../../core/infrastructure/socket.service");

// Helper to check target is Owner (creator of the organization)
async function isTargetOwner(client, orgId, userId) {
    const res = await client.query(
        `SELECT created_by FROM organizations WHERE org_id = $1`,
        [orgId]
    );
    return res.rowCount > 0 && res.rows[0].created_by === userId;
}

// 1. Get all roles in the organization
// 1. Get all roles in the organization
exports.getRoles = async (req, res, next) => {
    const orgId = req.params.orgId;
    try {
        const result = await pool.query(
            `SELECT r.*, r.is_active AS "isActive", COUNT(DISTINCT m.user_id)::int AS member_count,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', u.user_id,
                                'user_id', u.user_id,
                                'name', u.full_name,
                                'full_name', u.full_name,
                                'avatar', u.avatar_url,
                                'email', u.email,
                                'status', m.status,
                                'is_owner', (o.created_by = u.user_id)
                            )
                        ) FILTER (WHERE u.user_id IS NOT NULL),
                        '[]'::json
                    ) AS members
             FROM organization_roles r
             JOIN organizations o ON o.org_id = r.org_id
             LEFT JOIN organization_members m ON m.role_id = r.role_id AND m.status = 'ACTIVE'
             LEFT JOIN active_users u ON m.user_id = u.user_id
             WHERE r.org_id = $1 AND r.is_active = TRUE
             GROUP BY r.role_id, o.created_by
             ORDER BY r.priority DESC, r.created_at ASC`,
            [orgId]
        );
        const roles = result.rows.map(r => ({
            ...r,
            color: r.name.toLowerCase() === 'admin' ? '#06B6D4' : r.color
        }));
        res.json(roles);
    } catch (err) {
        next(err);
    }
};

// 2. Get single role detail
exports.getRoleById = async (req, res, next) => {
    const { orgId, roleId } = req.params;
    try {
        const result = await pool.query(
            `SELECT r.*, r.is_active AS "isActive", COUNT(DISTINCT m.user_id)::int AS member_count,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', u.user_id,
                                'user_id', u.user_id,
                                'name', u.full_name,
                                'full_name', u.full_name,
                                'avatar', u.avatar_url,
                                'email', u.email,
                                'status', m.status,
                                'invite_id', oi.invite_id,
                                'is_owner', (o.created_by = u.user_id)
                            )
                        ) FILTER (WHERE u.user_id IS NOT NULL),
                        '[]'::json
                    ) AS members
             FROM organization_roles r
             JOIN organizations o ON o.org_id = r.org_id
             LEFT JOIN organization_members m ON m.role_id = r.role_id AND m.status IN ('ACTIVE', 'PENDING_INVITE')
             LEFT JOIN active_users u ON m.user_id = u.user_id
             LEFT JOIN organization_invites oi ON (
                 oi.org_id = r.org_id 
                 AND oi.invited_user_id = m.user_id 
                 AND oi.status = 'PENDING'
             )
             WHERE r.org_id = $1 AND r.role_id = $2 AND r.is_active = TRUE
             GROUP BY r.role_id, o.created_by`,
            [orgId, roleId]
        );
        if (result.rowCount === 0) {
            return next(new AppError("Role not found", 404));
        }
        const role = result.rows[0];
        role.color = role.name.toLowerCase() === 'admin' ? '#06B6D4' : role.color;
        res.json(role);
    } catch (err) {
        next(err);
    }
};

// 3. Create dynamic role
exports.createRole = async (req, res, next) => {
    const orgId = req.params.orgId;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;
    const actorPriority = req.actor.rolePriority || 0;
    const { name, color, description, permissions = [] } = req.body;
    const upperPermissions = (Array.isArray(permissions) ? permissions : [])
        .map(p => typeof p === 'string' ? p.toUpperCase().trim() : p);

    if (!name) {
        return next(new AppError("Role name is required", 400));
    }

    if (name.toLowerCase() === 'owner' || name.toLowerCase() === 'admin') {
        return next(new AppError("Cannot create a role named Owner or Admin", 400));
    }

    // Validation: ACTIVITY_LOGS requires TEAMS
    if (upperPermissions.includes('ACTIVITY_LOGS') && !upperPermissions.includes('TEAMS')) {
        return next(new AppError("Activity logs requires Teams to be enabled for this role", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Check uniqueness within organization
        const dupCheck = await client.query(
            `SELECT 1 FROM organization_roles WHERE org_id = $1 AND LOWER(name) = LOWER($2) AND is_active = TRUE`,
            [orgId, name]
        );
        if (dupCheck.rowCount > 0) {
            throw new AppError("A role with this name already exists in the organization", 400);
        }

        // Validate that permissions only contain keys from organization_permission_keys with sort_order > 0
        const invalidKeyCheck = await client.query(
            `SELECT permission_key FROM organization_permission_keys 
             WHERE permission_key = ANY($1) AND sort_order = 0`,
            [upperPermissions]
        );
        if (invalidKeyCheck.rowCount > 0) {
            throw new AppError("System permission keys are not allowed for dynamic roles", 400);
        }

        // Priority for custom roles is capped at actor's priority - 1, default to 50 capped
        const rolePriority = Math.min(50, Math.max(0, actorPriority - 1));

        const insertRes = await client.query(
            `INSERT INTO organization_roles (org_id, name, color, description, permissions, priority, is_system_role)
             VALUES ($1, $2, $3, $4, $5, $6, FALSE)
             RETURNING *`,
            [orgId, name, color || '#808080', description || null, JSON.stringify(upperPermissions), rolePriority]
        );

        const newRole = insertRes.rows[0];

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'CREATE_ROLE',
            metadata: { roleName: name, permissions: upperPermissions }
        });

        await client.query("COMMIT");
        res.status(201).json(newRole);
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 4. Update dynamic role
exports.updateRole = async (req, res, next) => {
    const { orgId, roleId } = req.params;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;
    const actorPriority = req.actor.rolePriority || 0;
    const { name, color, description, permissions = [] } = req.body;
    const upperPermissions = (Array.isArray(permissions) ? permissions : [])
        .map(p => typeof p === 'string' ? p.toUpperCase().trim() : p);

    // Validation: ACTIVITY_LOGS requires TEAMS
    if (upperPermissions.includes('ACTIVITY_LOGS') && !upperPermissions.includes('TEAMS')) {
        return next(new AppError("Activity logs requires Teams to be enabled for this role", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const roleRes = await client.query(
            `SELECT * FROM organization_roles WHERE org_id = $1 AND role_id = $2 AND is_active = TRUE`,
            [orgId, roleId]
        );
        if (roleRes.rowCount === 0) {
            throw new AppError("Role not found", 404);
        }
        const role = roleRes.rows[0];

        const currentNameLower = role.name.toLowerCase();
        if ((currentNameLower === 'owner' || currentNameLower === 'admin') && name && name.toLowerCase() !== currentNameLower) {
            throw new AppError("Cannot rename the Owner or Admin role", 400);
        }

        if (name && (name.toLowerCase() === 'owner' || name.toLowerCase() === 'admin') && currentNameLower !== name.toLowerCase()) {
            throw new AppError("Cannot rename a role to Owner or Admin", 400);
        }

        if (name && name !== role.name) {
            const dupCheck = await client.query(
                `SELECT 1 FROM organization_roles WHERE org_id = $1 AND LOWER(name) = LOWER($2) AND role_id != $3 AND is_active = TRUE`,
                [orgId, name, roleId]
            );
            if (dupCheck.rowCount > 0) {
                throw new AppError("A role with this name already exists in the organization", 400);
            }
        }

        // Validate permissions
        const invalidKeyCheck = await client.query(
            `SELECT permission_key FROM organization_permission_keys 
             WHERE permission_key = ANY($1) AND sort_order = 0`,
            [upperPermissions]
        );
        if (invalidKeyCheck.rowCount > 0) {
            throw new AppError("System permission keys are not allowed for dynamic roles", 400);
        }



        const updateRes = await client.query(
            `UPDATE organization_roles
             SET name = COALESCE($3, name),
                 color = COALESCE($4, color),
                 description = COALESCE($5, description),
                 permissions = $6,
                 updated_at = NOW()
             WHERE org_id = $1 AND role_id = $2
             RETURNING *`,
            [orgId, roleId, name, color, description, JSON.stringify(upperPermissions)]
        );

        const updatedRole = updateRes.rows[0];

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'UPDATE_ROLE',
            metadata: { roleName: updatedRole.name, permissions, roleId }
        });

        await client.query("COMMIT");
        res.json(updatedRole);
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 5. Delete dynamic role
exports.deleteRole = async (req, res, next) => {
    const { orgId, roleId } = req.params;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;
    const actorPriority = req.actor.rolePriority || 0;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const roleRes = await client.query(
            `SELECT * FROM organization_roles WHERE org_id = $1 AND role_id = $2 AND is_active = TRUE`,
            [orgId, roleId]
        );
        if (roleRes.rowCount === 0) {
            throw new AppError("Role not found", 404);
        }
        const role = roleRes.rows[0];

        const roleNameLower = role.name.toLowerCase();
        if (roleNameLower === 'owner' || roleNameLower === 'admin') {
            throw new AppError("Cannot delete Owner or Admin roles", 400);
        }



        // Soft delete members who were in this role by setting status = 'REMOVED' and role_id = NULL
        await client.query(
            `UPDATE organization_members 
             SET status = 'REMOVED', role_id = NULL, updated_at = NOW() 
             WHERE org_id = $1 AND role_id = $2`,
            [orgId, roleId]
        );

        // Soft delete the role (and append a unique suffix to its name to free up the UNIQUE constraint for name reuse)
        await client.query(
            `UPDATE organization_roles 
             SET is_active = FALSE, 
                 name = name || '_deleted_' || EXTRACT(EPOCH FROM NOW())::text,
                 updated_at = NOW() 
             WHERE org_id = $1 AND role_id = $2`,
            [orgId, roleId]
        );

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'DELETE_ROLE',
            metadata: { roleName: role.name, roleId }
        });

        await client.query("COMMIT");
        res.json({ message: "Role deleted successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 6. Get members in a specific role
exports.getRoleMembers = async (req, res, next) => {
    const { orgId, roleId } = req.params;
    const { page = 1, limit = 20, search = '', status = 'ACTIVE' } = req.query;
    const offset = (page - 1) * limit;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url AS avatar, u.headline, om.joined_at, om.status
            FROM organization_members om
            JOIN active_users u ON om.user_id = u.user_id
            WHERE om.org_id = $1 AND om.role_id = $2
        `;
        const params = [orgId, roleId];
        let paramIndex = 3;

        if (status && status !== 'all') {
            query += ` AND om.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (search) {
            query += ` AND (u.full_name ILIKE $${paramIndex} OR u.headline ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        query += ` ORDER BY om.joined_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Get total count
        let countQuery = `
            SELECT COUNT(*)::int FROM organization_members om
            JOIN active_users u ON om.user_id = u.user_id
            WHERE om.org_id = $1 AND om.role_id = $2
        `;
        const countParams = [orgId, roleId];
        let countParamIdx = 3;

        if (status && status !== 'all') {
            countQuery += ` AND om.status = $${countParamIdx}`;
            countParams.push(status);
            countParamIdx++;
        }

        if (search) {
            countQuery += ` AND (u.full_name ILIKE $${countParamIdx} OR u.headline ILIKE $${countParamIdx})`;
            countParams.push(`%${search}%`);
            countParamIdx++;
        }

        const countRes = await pool.query(countQuery, countParams);
        const total = countRes.rows[0].count;

        res.json({
            data: result.rows,
            meta: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                total_pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        next(err);
    }
};

// 7. Get UI permission keys for checklist
exports.getPermissionKeys = async (req, res, next) => {
    try {
        const result = await pool.query(
            `SELECT * FROM organization_permission_keys 
             WHERE sort_order > 0 
             ORDER BY sort_order ASC`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
};

// 8. Get all members in organization
exports.getMembers = async (req, res, next) => {
    const orgId = req.params.orgId;
    const { page = 1, limit = 20, search = '', status = 'ACTIVE', exclude_owner, excludeOwner, exclude_self, excludeSelf } = req.query;
    const shouldExcludeOwner = exclude_owner === 'true' || exclude_owner === true || excludeOwner === 'true' || excludeOwner === true;
    const shouldExcludeSelf = exclude_self === 'true' || exclude_self === true || excludeSelf === 'true' || excludeSelf === true;
    const requesterId = req.actor?.userId || req.user?.sub;
    const offset = (page - 1) * limit;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url AS avatar, u.headline, u.email,
                   om.joined_at, om.status, om.expires_at, om.is_core_team,
                   r.role_id, r.name AS role_name, r.color AS role_color, r.priority AS role_priority,
                   (o.created_by = u.user_id) AS is_owner
            FROM organization_members om
            JOIN active_users u ON om.user_id = u.user_id
            JOIN organizations o ON o.org_id = om.org_id
            LEFT JOIN organization_roles r ON om.role_id = r.role_id
            WHERE om.org_id = $1
        `;
        const params = [orgId];
        let paramIndex = 2;

        if (shouldExcludeOwner) {
            query += ` AND om.user_id != o.created_by`;
        }

        if (shouldExcludeSelf && requesterId) {
            query += ` AND om.user_id != $${paramIndex}`;
            params.push(requesterId);
            paramIndex++;
        }

        if (status && status !== 'all') {
            query += ` AND om.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (search) {
            query += ` AND (u.full_name ILIKE $${paramIndex} OR u.headline ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        query += ` ORDER BY r.priority DESC, om.joined_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        let countQuery = `
            SELECT COUNT(*)::int FROM organization_members om
            JOIN active_users u ON om.user_id = u.user_id
            JOIN organizations o ON o.org_id = om.org_id
            WHERE om.org_id = $1
        `;
        const countParams = [orgId];
        let countParamIdx = 2;

        if (shouldExcludeOwner) {
            countQuery += ` AND om.user_id != o.created_by`;
        }

        if (shouldExcludeSelf && requesterId) {
            countQuery += ` AND om.user_id != $${countParamIdx}`;
            countParams.push(requesterId);
            countParamIdx++;
        }

        if (status && status !== 'all') {
            countQuery += ` AND om.status = $${countParamIdx}`;
            countParams.push(status);
            countParamIdx++;
        }

        if (search) {
            countQuery += ` AND (u.full_name ILIKE $${countParamIdx} OR u.headline ILIKE $${countParamIdx} OR u.email ILIKE $${countParamIdx})`;
            countParams.push(`%${search}%`);
            countParamIdx++;
        }

        const countRes = await pool.query(countQuery, countParams);
        const total = countRes.rows[0].count;

        const formattedRows = result.rows.map(r => ({
            ...r,
            role_color: (r.role_name && r.role_name.toLowerCase() === 'admin') ? '#06B6D4' : r.role_color
        }));
        res.json({
            data: formattedRows,
            meta: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                total_pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        next(err);
    }
};

// 9. Get specific member detail
exports.getMemberDetail = async (req, res, next) => {
    const { orgId, userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url AS avatar, u.headline, u.email,
                    om.joined_at, om.status, om.expires_at, om.is_core_team, om.title, om.description,
                    r.role_id, r.name AS role_name, r.color AS role_color, r.priority AS role_priority, r.permissions
             FROM organization_members om
             JOIN active_users u ON om.user_id = u.user_id
             LEFT JOIN organization_roles r ON om.role_id = r.role_id
             WHERE om.org_id = $1 AND om.user_id = $2`,
            [orgId, userId]
        );
        if (result.rowCount === 0) {
            return next(new AppError("Member not found", 404));
        }
        const member = result.rows[0];
        if (member.role_name && member.role_name.toLowerCase() === 'admin') {
            member.role_color = '#06B6D4';
        }
        res.json(member);
    } catch (err) {
        next(err);
    }
};

// 10. Assign role to a member
exports.updateMemberRole = async (req, res, next) => {
    const { orgId, userId } = req.params;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;
    const actorPriority = req.actor.rolePriority || 0;
    const { roleId, expiresAt = null, title = null, description = null, isCoreTeam = false } = req.body;

    if (!roleId) {
        return next(new AppError("Role ID is required", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Get target role priority
        const roleRes = await client.query(
            `SELECT * FROM organization_roles WHERE org_id = $1 AND role_id = $2`,
            [orgId, roleId]
        );
        if (roleRes.rowCount === 0) {
            throw new AppError("Role not found in this organization", 404);
        }
        const targetRole = roleRes.rows[0];

        if (targetRole.name === 'Owner') {
            throw new AppError("Cannot invite or assign directly to the Owner role. Use Transfer Ownership.", 400);
        }



        // Verify user is member and not Owner
        const targetOwner = await isTargetOwner(client, orgId, userId);
        if (targetOwner) {
            throw new AppError("Cannot demote the organization Owner", 403);
        }

        const updateRes = await client.query(
            `UPDATE organization_members
             SET role_id = $3,
                 expires_at = $4,
                 title = COALESCE($5, title),
                 description = COALESCE($6, description),
                 is_core_team = $7,
                 updated_at = NOW()
             WHERE org_id = $1 AND user_id = $2
             RETURNING *`,
            [orgId, userId, roleId, expiresAt, title, description, isCoreTeam]
        );

        if (updateRes.rowCount === 0) {
            throw new AppError("Member not found", 404);
        }

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'ASSIGN_ROLE',
            metadata: { targetUserId: userId, roleId, roleName: targetRole.name }
        });

        await client.query("COMMIT");
        res.json({ message: "Role assigned successfully", member: updateRes.rows[0] });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 11. Remove member
exports.removeMember = async (req, res, next) => {
    const { orgId, userId } = req.params;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;

    if (userId === actorId) {
        return next(new AppError("You cannot remove yourself. Use Leave instead.", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Verify target is not Owner
        const targetOwner = await isTargetOwner(client, orgId, userId);
        if (targetOwner) {
            throw new AppError("The organization Owner cannot be removed", 403);
        }

        const deleteRes = await client.query(
            `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2 RETURNING *`,
            [orgId, userId]
        );

        if (deleteRes.rowCount === 0) {
            throw new AppError("Member not found", 404);
        }

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'REMOVE_MEMBER',
            metadata: { targetUserId: userId }
        });

        await client.query("COMMIT");
        res.json({ message: "Member removed successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 12. Transfer Ownership
exports.transferOwnership = async (req, res, next) => {
    const orgId = req.params.orgId;
    const actorId = req.actor?.userId || req.user?.sub;
    const actorRole = req.actor?.roleName || 'Owner';
    const { newOwnerId } = req.body;

    if (!newOwnerId) {
        return next(new AppError("New owner user ID is required", 400));
    }

    if (newOwnerId === actorId) {
        return next(new AppError("You are already the owner", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Confirm actor is the current Owner
        const currentOwner = await isTargetOwner(client, orgId, actorId);
        if (!currentOwner) {
            throw new AppError("Only the Owner can transfer organization ownership", 403);
        }

        // 2. Check target member exists and is active
        const targetRes = await client.query(
            `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
            [orgId, newOwnerId]
        );
        if (targetRes.rowCount === 0) {
            throw new AppError("Target user is not an active member of this organization", 400);
        }

        // 3. Find or Create the Admin role for this org
        let adminRoleId;
        const adminRoleRes = await client.query(
            `SELECT role_id FROM organization_roles WHERE org_id = $1 AND name = 'Admin' LIMIT 1`,
            [orgId]
        );
        if (adminRoleRes.rowCount > 0) {
            adminRoleId = adminRoleRes.rows[0].role_id;
        } else {
            const adminCreate = await client.query(
                `INSERT INTO organization_roles (org_id, name, color, permissions, priority, is_system_role)
                 VALUES ($1, 'Admin', '#FFD700', '["*"]', 100, TRUE) RETURNING role_id`,
                [orgId]
            );
            adminRoleId = adminCreate.rows[0].role_id;
        }

        // 4. Update new owner role to Admin role in organization_members
        await client.query(
            `UPDATE organization_members SET role_id = $3, updated_at = NOW() WHERE org_id = $1 AND user_id = $2`,
            [orgId, newOwnerId, adminRoleId]
        );

        // 5. Update old owner role to Admin role in organization_members (demoting old owner to Admin)
        await client.query(
            `UPDATE organization_members SET role_id = $3, updated_at = NOW() WHERE org_id = $1 AND user_id = $2`,
            [orgId, actorId, adminRoleId]
        );

        // 6. Update organizations created_by to new owner
        await client.query(
            `UPDATE organizations SET created_by = $2, updated_at = NOW() WHERE org_id = $1`,
            [orgId, newOwnerId]
        );

        // 7. Insert record into ownership_transfers table (Option C)
        await client.query(
            `INSERT INTO ownership_transfers (org_id, transferred_from, transferred_to, metadata)
             VALUES ($1, $2, $3, $4)`,
            [orgId, actorId, newOwnerId, JSON.stringify({ transferred_by: actorId })]
        );

        // 8. Audit Log (Option C)
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'TRANSFER_OWNERSHIP',
            metadata: { previousOwnerId: actorId, newOwnerId }
        });

        await client.query("COMMIT");

        // 9. Emit Real-time Socket Events
        const socketPayload = {
            orgId,
            previousOwnerId: actorId,
            newOwnerId,
            timestamp: new Date().toISOString()
        };
        socketService.notifyUser(actorId, 'org_ownership_transferred', socketPayload);
        socketService.notifyUser(newOwnerId, 'org_ownership_transferred', socketPayload);

        socketService.notifyUser(actorId, 'org_list_updated', { orgId, action: 'demoted_to_admin' });
        socketService.notifyUser(newOwnerId, 'org_list_updated', { orgId, action: 'promoted_to_owner' });

        res.json({ message: "Ownership transferred successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 13. Get invite candidates (followers only, excluding members and pending invites)
exports.getInviteCandidates = async (req, res, next) => {
    const orgId = req.params.orgId;
    const { search = '', limit = 20, cursor = null } = req.query;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url AS avatar, u.headline, ofol.created_at as followed_at
            FROM organization_followers ofol
            JOIN active_users u ON ofol.user_id = u.user_id
            WHERE ofol.org_id = $1
              AND u.user_id NOT IN (
                  SELECT user_id FROM organization_members 
                  WHERE org_id = $1 AND status IN ('ACTIVE', 'SUSPENDED')
              )
              AND u.user_id NOT IN (
                  SELECT invited_user_id FROM organization_invites 
                  WHERE org_id = $1 AND status = 'PENDING' AND invited_user_id IS NOT NULL
              )
        `;
        const params = [orgId];
        let paramIndex = 2;

        if (search) {
            query += ` AND (u.full_name ILIKE $${paramIndex} OR u.headline ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (cursor) {
            // cursor is timestamp followed_at base64 encoded or string
            const cursorDate = new Date(Buffer.from(cursor, 'base64').toString('ascii'));
            if (!isNaN(cursorDate.getTime())) {
                query += ` AND ofol.created_at < $${paramIndex}`;
                params.push(cursorDate);
                paramIndex++;
            }
        }

        query += ` ORDER BY ofol.created_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await pool.query(query, params);

        let nextCursor = null;
        if (result.rowCount === parseInt(limit)) {
            const lastRow = result.rows[result.rowCount - 1];
            nextCursor = Buffer.from(new Date(lastRow.followed_at).toISOString()).toString('base64');
        }

        res.json({
            candidates: result.rows,
            meta: {
                has_more: result.rowCount === parseInt(limit),
                next_cursor: nextCursor
            }
        });
    } catch (err) {
        next(err);
    }
};

// 14. Send Invite (follower userId + roleId)
exports.sendInvite = async (req, res, next) => {
    const orgId = req.params.orgId;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;
    const actorPriority = req.actor.rolePriority || 0;
    const { userId, roleId } = req.body;

    if (!userId || !roleId) {
        return next(new AppError("User ID and Role ID are required", 400));
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Verify target role exists and check priority hierarchy
        const roleRes = await client.query(
            `SELECT * FROM organization_roles WHERE org_id = $1 AND role_id = $2`,
            [orgId, roleId]
        );
        if (roleRes.rowCount === 0) {
            throw new AppError("Role not found in this organization", 404);
        }
        const targetRole = roleRes.rows[0];

        if (targetRole.name === 'Owner') {
            throw new AppError("Cannot invite users to the Owner role", 400);
        }



        // 2. Verify target user follows the organization
        const followRes = await client.query(
            `SELECT 1 FROM organization_followers WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId]
        );
        if (followRes.rowCount === 0) {
            throw new AppError("This user is not following your organization", 400);
        }

        // 3. Verify target user is not already a member
        const memberRes = await client.query(
            `SELECT status FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId]
        );
        if (memberRes.rowCount > 0) {
            const status = memberRes.rows[0].status;
            if (status === 'ACTIVE' || status === 'SUSPENDED') {
                throw new AppError("User is already a member of this organization", 400);
            }
        }

        // 4. Verify no pending invite exists
        const inviteRes = await client.query(
            `SELECT 1 FROM organization_invites WHERE org_id = $1 AND invited_user_id = $2 AND status = 'PENDING'`,
            [orgId, userId]
        );
        if (inviteRes.rowCount > 0) {
            throw new AppError("User already has a pending invitation", 400);
        }

        // 5. Insert member with PENDING_INVITE status
        await client.query(
            `INSERT INTO organization_members (org_id, user_id, role_id, status, is_core_team)
             VALUES ($1, $2, $3, 'PENDING_INVITE', FALSE)
             ON CONFLICT (org_id, user_id) DO UPDATE 
             SET status = 'PENDING_INVITE', role_id = $3, updated_at = NOW()`,
            [orgId, userId, roleId]
        );

        // Fetch user email for organization_invites record
        const userRes = await client.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
        const email = userRes.rows[0].email;

        // 6. Insert invite record
        const token = require("crypto").randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiry
        await client.query(
            `INSERT INTO organization_invites (org_id, inviter_id, email, invited_user_id, role_id, role, token, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
             ON CONFLICT (org_id, email) DO UPDATE
             SET inviter_id = $2, invited_user_id = $4, role_id = $5, role = $6, token = $7, status = 'PENDING', expires_at = $8, updated_at = NOW()`,
            [orgId, actorId, email, userId, roleId, targetRole.name, token, expiresAt]
        );

        // 7. Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'INVITE_MEMBER',
            metadata: { targetUserId: userId, roleId, roleName: targetRole.name }
        });

        // 8. Persistent Notification and Real-time push
        try {
            const orgRes = await client.query(`SELECT name FROM organizations WHERE org_id = $1`, [orgId]);
            const orgName = orgRes.rows[0]?.name || "Organization";
            const actorRes = await client.query(`SELECT full_name, avatar_url FROM active_users WHERE user_id = $1`, [actorId]);
            const actorName = actorRes.rows[0]?.full_name || "Someone";
            const actorAvatar = actorRes.rows[0]?.avatar_url || null;
            const notifText = `${actorName} invited you to join ${orgName} as ${targetRole.name}`;

            const notifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                 VALUES ($1, $2, 'organization_invite', $3, $4, $5) RETURNING notification_id, created_at`,
                [userId, actorId, notifText, orgId, JSON.stringify({ token, orgId, orgName, role: targetRole.name })]
            );

            const notifId = notifRes.rows[0]?.notification_id;
            const notifCreatedAt = notifRes.rows[0]?.created_at ? notifRes.rows[0].created_at.toISOString() : new Date().toISOString();

            const socketService = require("../../services/socket.service");
            if (socketService && typeof socketService.notifyUser === 'function') {
                socketService.notifyUser(userId, "notification", {
                    type: "organization_invite",
                    text: notifText,
                    from: actorId,
                    sender_id: actorId,
                    senderName: actorName,
                    senderAvatar: actorAvatar,
                    actor_name: actorName,
                    actor_avatar: actorAvatar,
                    referenceId: orgId,
                    reference_id: orgId,
                    metadata: { token, orgId, orgName, role: targetRole.name },
                    notification_id: notifId,
                    created_at: notifCreatedAt,
                    is_read: false
                });
            }
        } catch (e) {
            console.error("[INVITE] Notification delivery failed:", e.message);
        }

        await client.query("COMMIT");
        res.json({
            message: "Invitation sent successfully",
            invite: {
                user_id: userId,
                role_id: roleId,
                role_name: targetRole.name,
                status: 'PENDING_INVITE'
            }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 15. Withdraw / Cancel Invite
exports.withdrawInvite = async (req, res, next) => {
    const { orgId, inviteId } = req.params;
    const actorId = req.actor.userId;
    const actorRole = req.actor.roleName;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const inviteRes = await client.query(
            `SELECT * FROM organization_invites WHERE org_id = $1 AND invite_id = $2 AND status = 'PENDING'`,
            [orgId, inviteId]
        );
        if (inviteRes.rowCount === 0) {
            throw new AppError("Pending invitation not found", 404);
        }
        const invite = inviteRes.rows[0];

        // 1. Cancel the invite
        await client.query(
            `UPDATE organization_invites SET status = 'CANCELLED', updated_at = NOW() 
             WHERE org_id = $1 AND invite_id = $2`,
            [orgId, inviteId]
        );

        // 2. Remove the member status from organization_members
        if (invite.invited_user_id) {
            await client.query(
                `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'PENDING_INVITE'`,
                [orgId, invite.invited_user_id]
            );
        }

        // Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId,
            actorRole,
            action: 'WITHDRAW_INVITE',
            metadata: { inviteId, targetUserId: invite.invited_user_id }
        });

        await client.query("COMMIT");
        res.json({ message: "Invitation withdrawn successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};

// 16. Get Pending Invites
exports.getPendingInvites = async (req, res, next) => {
    const orgId = req.params.orgId;
    try {
        const result = await pool.query(
            `SELECT oi.invite_id, oi.status, oi.expires_at, oi.created_at AS invited_at,
                    oi.invited_user_id AS user_id, oi.email, u.full_name, u.avatar_url AS avatar, u.headline,
                    r.role_id, r.name AS role_name, r.color AS role_color
             FROM organization_invites oi
             LEFT JOIN active_users u ON oi.invited_user_id = u.user_id
             LEFT JOIN organization_roles r ON oi.role_id = r.role_id
             WHERE oi.org_id = $1 AND oi.status = 'PENDING'
             ORDER BY oi.created_at DESC`,
            [orgId]
        );
        const formattedRows = result.rows.map(r => ({
            ...r,
            role_color: (r.role_name && r.role_name.toLowerCase() === 'admin') ? '#06B6D4' : r.role_color
        }));
        res.json({
            data: formattedRows,
            meta: { total: result.rowCount }
        });
    } catch (err) {
        next(err);
    }
};

// 17. Get Activity / Audit Logs
exports.getActivityLogs = async (req, res, next) => {
    const orgId = req.params.orgId;
    const { page = 1, limit = 20, action, memberId, roleId, dateFrom, dateTo, search, cursorCreatedAt, cursorLogId } = req.query;
    const limitNum = parseInt(limit, 10) || 20;
    const offset = (parseInt(page, 10) - 1) * limitNum;

    try {
        let query = `
            SELECT al.log_id, al.action, al.created_at, al.actor_role, al.metadata,
                   u.user_id AS actor_id, u.full_name AS actor_name, u.avatar_url AS actor_avatar
            FROM audit_logs al
            JOIN active_users u ON al.actor_id = u.user_id
            JOIN organization_members om ON om.user_id = al.actor_id AND om.org_id = al.entity_id AND om.status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')
            WHERE al.entity_id = $1 AND al.entity_type = 'ORGANIZATION'
              AND al.action NOT IN ('TEAMS', 'ACTIVITY_LOGS', 'ROLES', 'VIEW_TEAMS', 'VIEW_ACTIVITY_LOGS', 'VIEW_ROLES', 'VIEW_MEMBERS', 'MEMBERS')
        `;
        const params = [orgId];
        let paramIdx = 2;

        if (cursorCreatedAt && cursorLogId) {
            query += ` AND (al.created_at, al.log_id) < ($${paramIdx}, $${paramIdx + 1})`;
            params.push(cursorCreatedAt, cursorLogId);
            paramIdx += 2;
        }

        if (action) {
            query += ` AND al.action = $${paramIdx}`;
            params.push(action);
            paramIdx++;
        }

        if (roleId && roleId !== 'all') {
            query += ` AND (
                om.role_id = $${paramIdx} OR 
                LOWER(al.actor_role) = (SELECT LOWER(name) FROM organization_roles WHERE role_id = $${paramIdx} AND org_id = $1)
            )`;
            params.push(roleId);
            paramIdx++;
        }

        if (memberId && memberId !== 'all') {
            query += ` AND al.actor_id = $${paramIdx}`;
            params.push(memberId);
            paramIdx++;
        }

        if (dateFrom) {
            query += ` AND al.created_at >= $${paramIdx}`;
            params.push(new Date(dateFrom));
            paramIdx++;
        }

        if (dateTo) {
            query += ` AND al.created_at <= $${paramIdx}`;
            params.push(new Date(dateTo));
            paramIdx++;
        }

        if (search && search.trim().length >= 3) {
            const term = search.trim();
            query += ` AND (
                al.action ILIKE $${paramIdx} OR
                u.full_name ILIKE $${paramIdx} OR
                al.actor_role ILIKE $${paramIdx} OR
                al.metadata::text ILIKE $${paramIdx} OR
                (LOWER($${paramIdx}) LIKE '%feed%' AND al.action IN ('CREATE_POST', 'EDIT_POST', 'LIKE', 'COMMENT', 'REPOST', 'SHARE_POST', 'SAVE_POST'))
            )`;
            params.push(`%${term}%`);
            paramIdx++;
        }

        if (cursorCreatedAt && cursorLogId) {
            query += ` ORDER BY al.created_at DESC, al.log_id DESC LIMIT $${paramIdx}`;
            params.push(limitNum);
        } else {
            query += ` ORDER BY al.created_at DESC, al.log_id DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
            params.push(limitNum, offset);
        }

        const result = await pool.query(query, params);

        // Get total count
        let countQuery = `
            SELECT COUNT(DISTINCT al.log_id)::int FROM audit_logs al
            JOIN active_users u ON al.actor_id = u.user_id
            JOIN organization_members om ON om.user_id = al.actor_id AND om.org_id = al.entity_id AND om.status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')
            WHERE al.entity_id = $1 AND al.entity_type = 'ORGANIZATION'
              AND al.action NOT IN ('TEAMS', 'ACTIVITY_LOGS', 'ROLES', 'VIEW_TEAMS', 'VIEW_ACTIVITY_LOGS', 'VIEW_ROLES', 'VIEW_MEMBERS', 'MEMBERS')
        `;
        const countParams = [orgId];
        let countParamIdx = 2;

        if (action) {
            countQuery += ` AND al.action = $${countParamIdx}`;
            countParams.push(action);
            countParamIdx++;
        }

        if (roleId && roleId !== 'all') {
            countQuery += ` AND (
                om.role_id = $${countParamIdx} OR 
                LOWER(al.actor_role) = (SELECT LOWER(name) FROM organization_roles WHERE role_id = $${countParamIdx} AND org_id = $1)
            )`;
            countParams.push(roleId);
            countParamIdx++;
        }

        if (memberId && memberId !== 'all') {
            countQuery += ` AND al.actor_id = $${countParamIdx}`;
            countParams.push(memberId);
            countParamIdx++;
        }

        if (dateFrom) {
            countQuery += ` AND al.created_at >= $${countParamIdx}`;
            countParams.push(new Date(dateFrom));
            countParamIdx++;
        }

        if (dateTo) {
            countQuery += ` AND al.created_at <= $${countParamIdx}`;
            countParams.push(new Date(dateTo));
            countParamIdx++;
        }

        if (search && search.trim().length >= 3) {
            const term = search.trim();
            countQuery += ` AND (
                al.action ILIKE $${countParamIdx} OR
                u.full_name ILIKE $${countParamIdx} OR
                al.actor_role ILIKE $${countParamIdx} OR
                al.metadata::text ILIKE $${countParamIdx} OR
                (LOWER($${countParamIdx}) LIKE '%feed%' AND al.action IN ('CREATE_POST', 'EDIT_POST', 'LIKE', 'COMMENT', 'REPOST', 'SHARE_POST', 'SAVE_POST'))
            )`;
            countParams.push(`%${term}%`);
            countParamIdx++;
        }

        const countRes = await pool.query(countQuery, countParams);
        const total = countRes.rows[0].count;
        const lastRow = result.rows[result.rows.length - 1];

        res.json({
            data: result.rows,
            nextCursor: lastRow ? { cursorCreatedAt: lastRow.created_at, cursorLogId: lastRow.log_id } : null,
            meta: {
                total,
                page: parseInt(page, 10),
                limit: limitNum,
                total_pages: Math.ceil(total / limitNum)
            }
        });
    } catch (err) {
        next(err);
    }
};
