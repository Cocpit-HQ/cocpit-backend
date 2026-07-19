const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const chatSessionCtrl = require("../messaging/chatSession.controller");
const { checkOrgPermission } = require("../../core/utils/rbac");
const socketService = require("../../core/infrastructure/socket.service");

const { logAudit } = require("../../core/infrastructure/audit.service");

exports.inviteMember = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { email, role } = req.body; // Role name (e.g. "Editor")

    if (!email || !role) {
        return res.status(400).json({ message: "Valid email and role are required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 2. Role Escalation Check
        // Get inviter's priority
        const inviterRes = await client.query(
            `SELECT cr.priority FROM organization_members cm 
             JOIN organization_roles cr ON cm.role_id = cr.role_id 
             WHERE cm.org_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );
        const inviterPriority = inviterRes.rows[0]?.priority || 0;

        // Get target role priority
        const targetRoleQuery = await client.query(
            `SELECT role_id, priority FROM organization_roles WHERE org_id = $1 AND name ILIKE $2`,
            [companyId, role]
        );
        if (targetRoleQuery.rowCount === 0) throw new Error("Invalid role specified");

        const targetRoleData = targetRoleQuery.rows[0];
        if (targetRoleData.priority > inviterPriority) {
            throw new Error("You cannot assign a role with higher priority than your own.");
        }

        // 3. Rate Limit
        const rateLimitRes = await client.query(
            `SELECT COUNT(*) FROM organization_invites 
             WHERE org_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
            [companyId]
        );
        if (parseInt(rateLimitRes.rows[0].count) >= 20) { // Increased limit
            throw new Error("Rate limit exceeded: Max 20 invites per day per organization.");
        }

        // 4. Create Invite
        const token = require('crypto').randomBytes(20).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await client.query(
            `INSERT INTO organization_invites (org_id, inviter_id, email, role, role_id, token, expires_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
             ON CONFLICT (org_id, email) 
             DO UPDATE SET 
                role = EXCLUDED.role,
                role_id = EXCLUDED.role_id,
                token = EXCLUDED.token,
                expires_at = EXCLUDED.expires_at,
                inviter_id = EXCLUDED.inviter_id,
                status = 'PENDING',
                updated_at = NOW()`,
            [companyId, userId, email, role, targetRoleData.role_id, token, expiresAt]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'INVITE_MEMBER',
            metadata: { email, role }
        });

        await client.query("COMMIT");

        // --- Notification Delivery (post-commit, non-transactional) ---
        const inviteLink = `/company/invite/accept?token=${token}`;
        let userFound = false;

        try {
            // Look up invited user on the platform
            const invitedUserRes = await pool.query(
                `SELECT user_id, full_name FROM users WHERE email = $1`, [email]
            );

            // Get company name + inviter details for the notification
            const companyRes = await pool.query(
                `SELECT name FROM organizations WHERE org_id = $1`, [companyId]
            );
            const inviterDetailsRes = await pool.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]
            );
            const organizationName = companyRes.rows[0]?.name || 'an organization';
            const inviterName = inviterDetailsRes.rows[0]?.full_name || 'Someone';
            const inviterAvatar = inviterDetailsRes.rows[0]?.avatar_url;

            if (invitedUserRes.rowCount > 0) {
                userFound = true;
                const targetUserId = invitedUserRes.rows[0].user_id;
                const notifText = `${inviterName} invited you to join ${organizationName} as ${role}`;

                // Persist notification
                const notifRes = await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                     VALUES ($1, $2, 'organization_invite', $3, $4, $5) RETURNING notification_id, created_at`,
                    [targetUserId, userId, notifText, companyId,
                        JSON.stringify({ token, orgId: companyId, orgName: organizationName, role, inviteLink })]
                );

                // Real-time socket push (include actor_* fields for popover rendering)
                socketService.notifyUser(targetUserId, "notification", {
                    type: "organization_invite",
                    text: notifText,
                    from: userId,
                    sender_id: userId,
                    senderName: inviterName,
                    senderAvatar: inviterAvatar,
                    actor_name: inviterName,
                    actor_avatar: inviterAvatar,
                    referenceId: companyId,
                    reference_id: companyId,
                    metadata: { token, orgId: companyId, orgName: organizationName, role, inviteLink },
                    notification_id: notifRes.rows[0].notification_id,
                    created_at: notifRes.rows[0].created_at.toISOString(),
                    is_read: false
                });

                console.log(`[INVITE] Notification sent to ${email} (userId: ${targetUserId})`);
            } else {
                console.log(`[INVITE] User ${email} not found on platform. Invite link: ${inviteLink}`);
            }
        } catch (notifErr) {
            // Non-critical: invite was created successfully, notification is best-effort
            console.error("[INVITE] Notification delivery failed:", notifErr.message);
        }

        res.status(200).json({
            message: userFound
                ? "Invitation sent to user"
                : "User not found on Cocpit. Share the invite link manually.",
            inviteLink: `/organization/invite/accept?token=${token}`,
            token,
            userFound
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Invite member error:", err);
        if (err.message.startsWith("Forbidden") || err.message.startsWith("You cannot")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
};

exports.acceptTeamsInvite = async (req, res) => {
    const { token } = req.body;
    const userId = req.user.sub; // User accepting the invite

    if (!token) return res.status(400).json({ message: "Token is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Find Invite
        const inviteRes = await client.query(
            `SELECT * FROM organization_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > NOW()`,
            [token]
        );

        if (inviteRes.rowCount === 0) {
            throw new Error("Invalid or expired invitation");
        }
        const invite = inviteRes.rows[0];

        // 2. Verify Email Match (Optional but recommended security)
        // Check if current user's email matches invite email? 
        // For now, let's assume possession of token is enough, or we can check.
        const userRes = await client.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
        if (userRes.rows[0].email !== invite.email) {
            console.warn(`[Invite] Email mismatch blocked: Invite ${invite.email} attempted by ${userRes.rows[0].email}`);
            throw new AppError(`This invitation was sent to ${invite.email}. You are logged in as ${userRes.rows[0].email}.`, 403);
        }

        // 2b. Check if User is ALREADY a member
        const memberCheck = await client.query(
            `SELECT cr.name as role FROM organization_members cm JOIN organization_roles cr ON cm.role_id = cr.role_id WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status IN ('ACTIVE', 'SUSPENDED')`,
            [invite.org_id, userId]
        );

        if (memberCheck.rowCount > 0) {
            const existingRole = memberCheck.rows[0].role;
            if (existingRole === 'Owner') { // Changed from 'OWNER' to 'Owner' to match case in roles array
                throw new Error("You are the OWNER of this organization. You cannot accept an invitation.");
            } else {
                throw new Error(`You are already a member as ${existingRole}.`);
            }
        }

        // 3. Add to Members
        // Use role_id from invite if available, fallback to lookup
        let roleId = invite.role_id;
        if (!roleId) {
            const roleRes = await client.query(`SELECT role_id FROM organization_roles WHERE org_id = $1 AND name ILIKE $2`, [invite.org_id, invite.role]);
            roleId = roleRes.rows[0]?.role_id;
        }

        if (roleId) {
            await client.query(
                `INSERT INTO organization_members (org_id, user_id, role_id, status) VALUES ($1, $2, $3, 'ACTIVE')
                 ON CONFLICT (org_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = 'ACTIVE', updated_at = NOW()`,
                [invite.org_id, userId, roleId]
            );
        } else {
            // Fallback for very old invites? Should not happen with fresh migration
            throw new Error("Invalid role configuration for this invite.");
        }

        // 4. Update Invite Status
        await client.query(
            `UPDATE organization_invites SET status = 'ACCEPTED', updated_at = NOW() WHERE invite_id = $1`,
            [invite.invite_id]
        );

        await logAudit(client, {
            entityId: invite.org_id,
            actorId: userId,
            action: 'JOIN_ORGANIZATION',
            metadata: { inviteId: invite.invite_id, role: invite.role }
        });

        await client.query("COMMIT");
        res.json({ message: "Invitation accepted. You are now a member." });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Accept invite error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        if (err.message === "Invalid or expired invitation") {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getMembers = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { page = 1, limit = 10, status } = req.query;
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
        // Build Query
        let whereClause = `WHERE cm.org_id = $1`;
        const params = [companyId, limit, offset];
        if (status) {
            whereClause += ` AND cm.status = $4`;
            params.push(status);
        }

        const countRes = await client.query(
            `SELECT COUNT(*) FROM organization_members cm ${whereClause}`,
            status ? [companyId, status] : [companyId]
        );
        const total = parseInt(countRes.rows[0].count);

        const result = await client.query(
            `SELECT 
                u.user_id, u.full_name, u.email, u.avatar_url, 
                cr.name as role, cr.color as role_color, cr.priority,
                cm.joined_at, cm.status, cm.expires_at,
                cm.is_primary_display
             FROM organization_members cm
             JOIN active_users u ON cm.user_id = u.user_id
             JOIN organization_roles cr ON cm.role_id = cr.role_id
             ${whereClause}
             ORDER BY cr.priority DESC, cm.joined_at ASC
             LIMIT $2 OFFSET $3`,
            params
        );

        const formattedRows = result.rows.map(r => ({
            ...r,
            role_color: (r.role && r.role.toLowerCase() === 'admin') ? '#06B6D4' : r.role_color
        }));

        res.json({
            data: formattedRows,
            meta: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error("Get members error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.removeMember = async (req, res) => {
    const { orgId: companyId, memberId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 2. Check target member role
        const targetRes = await client.query(
            `SELECT cr.name as role, cr.priority FROM organization_members cm 
             JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2`,
            [companyId, memberId]
        );
        if (targetRes.rowCount === 0) throw new Error("Member not found");
        const targetRole = targetRes.rows[0].role;
        const targetPriority = targetRes.rows[0].priority;

        // 3. Enforce Hierarchy
        // Look up requester priority
        const requesterRes = await client.query(
            `SELECT cr.priority FROM organization_members cm 
             JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );
        const requesterPriority = requesterRes.rows[0].priority;

        if (targetPriority >= requesterPriority) {
            throw new Error("You cannot remove a member with equal or higher priority.");
        }

        // 4. Remove
        await client.query(
            `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [companyId, memberId]
        );

        // Lifecycle: End all active sessions for this member
        const endedSessions = await chatSessionCtrl.endAllSessionsForMember(client, companyId, memberId, userId);

        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'REMOVE_MEMBER',
            metadata: { removedUserId: memberId, removedRole: targetRole }
        });

        await client.query("COMMIT");
        res.json({ message: "Member removed successfully" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Remove member error:", err);
        if (err.message.startsWith("Forbidden") || err.message.startsWith("Cannot") || err.message.startsWith("Admins")) {
            return res.status(403).json({ message: err.message });
        }
        if (err.message === "Member not found") {
            return res.status(404).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.leaveOrganization = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Check existence and role
        const resRole = await client.query(
            `SELECT oroles.name AS role_name FROM organization_members om
             JOIN organization_roles oroles ON om.role_id = oroles.role_id
             WHERE om.org_id = $1 AND om.user_id = $2`,
            [companyId, userId]
        );
        if (resRole.rowCount === 0) throw new Error("You are not a member of this organization");
        const roleName = resRole.rows[0].role_name;

        // 2. OWNER cannot leave
        if (roleName === 'Owner') throw new Error("OWNER cannot leave. Transfer ownership first.");

        // 3. Leave
        await client.query(
            `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [companyId, userId]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: userId, // Self-action
            action: 'LEAVE_ORGANIZATION',
            metadata: { role: roleName }
        });

        await client.query("COMMIT");
        res.json({ message: "You have left the organization" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Leave organization error:", err);
        if (err.message.startsWith("OWNER")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.transferOwnership = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    let { newOwnerId } = req.body;

    if (!newOwnerId) return res.status(400).json({ message: "New Owner ID or Email required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Resolve email to UUID if necessary
        if (newOwnerId.includes('@')) {
            const userRes = await client.query("SELECT user_id FROM users WHERE email = $1", [newOwnerId]);
            if (userRes.rowCount === 0) {
                throw new AppError("User with this email not found", 404);
            }
            newOwnerId = userRes.rows[0].user_id;
        }

        // 1. RBAC (OWNER ONLY)
        const isOwner = await checkOrgPermission(client, companyId, userId, '*');
        if (!isOwner) throw new Error("Forbidden: Only OWNER can transfer ownership");

        const { password } = req.body;
        if (!password) {
            throw new AppError("Password is required to transfer ownership", 400);
        }

        // Verify password
        const userRes = await client.query("SELECT password_hash FROM users WHERE user_id = $1", [userId]);
        const { comparePassword } = require("../../core/utils/password");
        const isValid = await comparePassword(password, userRes.rows[0].password_hash);
        if (!isValid) throw new AppError("Invalid password", 401);

        // 2. Transaction
        // Get Role IDs
        const rolesRes = await client.query(`SELECT role_id, name FROM organization_roles WHERE org_id = $1 AND name IN ('Owner', 'Admin')`, [companyId]);
        const ownerRole = rolesRes.rows.find(r => r.name === 'Owner');
        const adminRole = rolesRes.rows.find(r => r.name === 'Admin');

        if (!ownerRole || !adminRole) throw new Error("System roles missing");

        // Demote current OWNER to ADMIN
        await client.query(
            `UPDATE organization_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
            [adminRole.role_id, companyId, userId]
        );

        // Promote new user to OWNER
        const memberCheck = await client.query(
            `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [companyId, newOwnerId]
        );

        if (memberCheck.rowCount > 0) {
            await client.query(
                `UPDATE organization_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
                [ownerRole.role_id, companyId, newOwnerId]
            );
        } else {
            await client.query(
                `INSERT INTO organization_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
                [companyId, newOwnerId, ownerRole.role_id]
            );
        }

        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'TRANSFER_OWNERSHIP',
            metadata: { from: userId, to: newOwnerId }
        });

        await client.query("COMMIT");
        res.json({ message: "Ownership transferred successfully" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Transfer ownership error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        if (err.message.startsWith("Forbidden")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Update member role settings (Self-service: set primary, toggle visibility)
exports.updateMemberRoleSettings = async (req, res, next) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { is_primary_display, is_role_visible } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check verification (ensure user is actually a member)
        const memberCheck = await client.query(
            `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [companyId, userId]
        );

        if (memberCheck.rowCount === 0) {
            throw new AppError("You are not a member of this organization", 403);
        }

        // Handle Primary Display Logic
        if (is_primary_display === true) {
            // Unset primary for all other roles of this user
            await client.query(
                `UPDATE organization_members SET is_primary_display = FALSE WHERE user_id = $1`,
                [userId]
            );
        }

        // Update the specific record
        const query = `
            UPDATE organization_members 
            SET 
                is_primary_display = COALESCE($1, is_primary_display),
                is_role_visible = COALESCE($2, is_role_visible)
            WHERE org_id = $3 AND user_id = $4
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

exports.getUserPendingTeamsInvites = async (req, res, next) => {
    const userId = req.user.sub;
    try {
        const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        const email = userRes.rows[0]?.email;

        const result = await pool.query(
            `SELECT oi.invite_id, oi.org_id, o.name AS org_name, o.logo_url AS org_logo,
                    oi.role, oi.role_id, oi.token, oi.expires_at, oi.created_at AS invited_at,
                    u.full_name AS inviter_name, u.avatar_url AS inviter_avatar
             FROM organization_invites oi
             JOIN organizations o ON oi.org_id = o.org_id
             LEFT JOIN users u ON oi.inviter_id = u.user_id
             WHERE (oi.invited_user_id = $1 OR LOWER(oi.email) = LOWER($2)) 
               AND oi.status = 'PENDING' 
               AND oi.expires_at > NOW()
             ORDER BY oi.created_at DESC`,
            [userId, email]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
};

exports.declineTeamsInvite = async (req, res, next) => {
    const { token } = req.body;
    const userId = req.user.sub;

    if (!token) return next(new AppError("Token is required", 400));

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const inviteRes = await client.query(
            `SELECT * FROM organization_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > NOW()`,
            [token]
        );

        if (inviteRes.rowCount === 0) {
            throw new AppError("Invalid or expired invitation", 404);
        }
        const invite = inviteRes.rows[0];

        const userRes = await client.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
        if (userRes.rows[0].email !== invite.email) {
            throw new AppError(`This invitation was sent to ${invite.email}. You are logged in as ${userRes.rows[0].email}.`, 403);
        }

        await client.query(
            `UPDATE organization_invites SET status = 'DECLINED', updated_at = NOW() WHERE invite_id = $1`,
            [invite.invite_id]
        );

        if (invite.invited_user_id) {
            await client.query(
                `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'PENDING_INVITE'`,
                [invite.org_id, invite.invited_user_id]
            );
        }

        await logAudit(client, {
            entityId: invite.org_id,
            actorId: userId,
            action: 'DECLINE_INVITATION',
            metadata: { inviteId: invite.invite_id, role: invite.role }
        });

        await client.query("COMMIT");
        res.json({ message: "Invitation declined successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        next(err);
    } finally {
        client.release();
    }
};
