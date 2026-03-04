const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const chatSessionCtrl = require("../messaging/chatSession.controller");
const { checkCompanyPermission } = require("../../core/utils/rbac");
const socketService = require("../../core/infrastructure/socket.service");

// Helper for Audit Logging
const logAudit = async (client, { entityId, actorId, action, metadata = {} }) => {
    const query = `
    INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `;
    await client.query(query, ['COMPANY', entityId, actorId, action, metadata]);
};

// Helper: checkRole was removed in favor of checkCompanyPermission

// --- Updated Permissions Helper ---
// Replaces checkRole with new middleware logic usage pattern or direct DB check
// checkPermission replaced by checkCompanyPermission from utils/rbac

exports.createCompany = async (req, res) => {
    const userId = req.user.sub;
    const { name, slug, email, industry, size, website, location, description } = req.body;

    // 1. Validation
    if (!name || !slug) {
        return res.status(400).json({ message: "Name and Slug are required" });
    }

    // Validate slug constraints
    const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!slugRegex.test(slug)) {
        return res.status(400).json({ message: "Invalid slug format. Use lowercase letters, numbers, and hyphens only." });
    }
    if (slug.length > 50) {
        return res.status(400).json({ message: "Slug is too long (max 50 chars)" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 2. Rate Limit (3 per day)
        const rateLimitRes = await client.query(
            `SELECT COUNT(*) FROM audit_logs 
       WHERE actor_id = $1 AND action = 'CREATE' AND created_at > NOW() - INTERVAL '1 day'`,
            [userId]
        );
        if (parseInt(rateLimitRes.rows[0].count) >= 3) {
            throw new AppError("Rate limit exceeded: You can only create 3 companies per day.", 429);
        }

        // 2b. Max Active Companies Limit (5)
        const activeRes = await client.query(
            `SELECT COUNT(*) FROM company_members WHERE user_id = $1 AND role = 'OWNER'`,
            [userId]
        );
        if (parseInt(activeRes.rows[0].count) >= 5) {
            throw new AppError("Limit reached: You can own a maximum of 5 companies.", 429);
        }

        // 3. Normalized Unique Check
        const slugCheck = await client.query(`SELECT 1 FROM companies WHERE slug = $1`, [slug]);
        if (slugCheck.rowCount > 0) {
            throw new Error("Slug already taken");
        }

        // Check if slug is reserved/soft-deleted (within 30 days) - OPTIONAL based on requirement "Prevent slug reuse for 30 days"
        // The soft delete implementation keeps the row, so the unique constraint on slug might conflict if we don't handle it.
        // However, the requirement says "Prevent slug reuse", so uniqueness on slug (even deleted ones) corresponds to this.
        // If we wanted to allow reuse after 30 days, we'd need partial index or move deleted to archive.
        // For MVP, unique constraint on main table holds.

        // 4. Create Company
        const insertCompanyText = `
      INSERT INTO companies (name, slug, email, industry, size, website, location, description, slogan)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
        const companyRes = await client.query(insertCompanyText, [
            name, slug, email, industry, size, website, location, description, req.body.slogan
        ]);
        const company = companyRes.rows[0];

        // 5. Add Creator as OWNER
        // Get Owner Role ID
        const ownerRoleRes = await client.query(`SELECT role_id FROM company_roles WHERE company_id = $1 AND name = 'Owner'`, [company.company_id]);
        // Default roles should have been created by trigger if we had one, but we are migrating.
        // Wait, for NEW companies, we need to create default roles!
        // The migration script only handles EXISTING companies.
        // We need a helper to create default roles for a new company.

        // Let's create default roles inline here for now or use a shared helper.
        const roles = [
            { name: 'Owner', color: '#FFD700', permissions: ["*"], priority: 100, is_system: true },
            { name: 'Admin', color: '#FF0000', permissions: ["SWITCH_TO_COMPANY", "MANAGE_COMPANY", "MANAGE_COMPANY_DETAILS", "MANAGE_SETTINGS", "MANAGE_ROLES", "MANAGE_MEMBERS", "INVITE_MEMBERS", "REMOVE_MEMBERS", "VIEW_MEMBERS", "POST_JOBS", "VIEW_APPLICANTS", "MANAGE_APPLICANTS", "CREATE_CONTENT", "MANAGE_COMMENTS", "VIEW_ANALYTICS"], priority: 90, is_system: true },
            { name: 'Editor', color: '#00FF00', permissions: ["SWITCH_TO_COMPANY", "CREATE_CONTENT", "VIEW_ANALYTICS", "VIEW_MEMBERS", "MANAGE_COMPANY_DETAILS"], priority: 60, is_system: true },
            { name: 'Recruiter', color: '#0000FF', permissions: ["SWITCH_TO_COMPANY", "POST_JOBS", "VIEW_APPLICANTS", "MANAGE_APPLICANTS", "VIEW_MEMBERS"], priority: 50, is_system: true },
            { name: 'Analyst', color: '#800080', permissions: ["SWITCH_TO_COMPANY", "VIEW_ANALYTICS", "VIEW_MEMBERS"], priority: 40, is_system: true }
        ];

        let ownerRoleId;

        for (const r of roles) {
            const rRes = await client.query(
                `INSERT INTO company_roles (company_id, name, color, permissions, priority, is_system_role)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING role_id`,
                [company.company_id, r.name, r.color, JSON.stringify(r.permissions), r.priority, r.is_system]
            );
            if (r.name === 'Owner') ownerRoleId = rRes.rows[0].role_id;
        }

        await client.query(
            `INSERT INTO company_members (company_id, user_id, role_id) VALUES ($1, $2, $3)`,
            [company.company_id, userId, ownerRoleId]
        );

        // 6. Audit Log
        await logAudit(client, {
            entityId: company.company_id,
            actorId: userId,
            action: 'CREATE',
            metadata: { name, slug }
        });

        await client.query("COMMIT");

        res.status(201).json({ message: "Company created successfully", company });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Create company error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        if (err.message.includes("Slug already taken")) {
            return res.status(409).json({ message: "Slug is already taken" });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.checkSlug = async (req, res) => {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ message: "Slug is required" });

    try {
        const result = await pool.query(
            `SELECT 1 FROM companies WHERE slug = $1`,
            [slug]
        );
        // Also check soft-deleted if we want to enforce 30-day rule strictly for user feedback
        // But unique constraint covers it.

        if (result.rowCount > 0) {
            return res.json({ available: false, message: "Slug is taken" });
        }

        // Reserved words check (hardcoded blocklist for MVP)
        const reserved = ['admin', 'api', 'cocpit', 'support', 'help', 'career'];
        if (reserved.includes(slug.toLowerCase())) {
            return res.json({ available: false, message: "Slug is reserved" });
        }

        res.json({ available: true, message: "Slug is available" });
    } catch (err) {
        console.error("Check slug error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getCompany = async (req, res) => {
    const { slug } = req.params;
    const userId = req.user?.sub; // Optional

    try {
        const result = await pool.query(
            `SELECT c.*,
        (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = c.company_id) as member_count,
        ${userId ? `(
            SELECT json_build_object(
                'name', cr.name,
                'permissions', cr.permissions,
                'priority', cr.priority
            )
            FROM company_members cm 
            JOIN company_roles cr ON cm.role_id = cr.role_id 
            WHERE cm.company_id = c.company_id AND cm.user_id = $2
        ) as viewer_role_data` : 'NULL as viewer_role_data'}
       FROM companies c
       WHERE c.slug = $1 AND c.is_deleted = FALSE`,
            userId ? [slug, userId] : [slug]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Company not found" });
        }

        const company = result.rows[0];

        // Audit Log for Analytics (Async, don't block response)
        // We need a client for this. Since we used pool.query above, we don't have a transaction client.
        // It's fine to fire and forget or use pool.
        if (userId && company.company_id) {
            (async () => {
                const auditClient = await pool.connect();
                try {
                    // Refinement: Debounce VIEW logs (1 hour cooldown)
                    const lastViewRes = await auditClient.query(
                        `SELECT created_at FROM audit_logs 
                         WHERE entity_id = $1 AND entity_type = 'COMPANY' AND actor_id = $2 AND action = 'VIEW' 
                         ORDER BY created_at DESC LIMIT 1`,
                        [company.company_id, userId]
                    );

                    let shouldLog = true;
                    if (lastViewRes.rowCount > 0) {
                        const lastViewTime = new Date(lastViewRes.rows[0].created_at).getTime();
                        const timeDiff = Date.now() - lastViewTime;
                        if (timeDiff < 60 * 60 * 1000) { // 1 hour
                            shouldLog = false;
                        }
                    }

                    if (shouldLog) {
                        await logAudit(auditClient, {
                            entityId: company.company_id,
                            actorId: userId,
                            action: 'VIEW',
                            metadata: { source: 'profile_page' }
                        });
                    }
                } catch (e) { console.error("Audit log error:", e); }
                finally { auditClient.release(); }
            })();
        }

        res.json(company);
    } catch (err) {
        console.error("Get company error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateCompany = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { name, slogan, industry, size, website, location, description, logo_url, cover_url, headline } = req.body;

    // Basic validation
    if (!name || name.trim().length < 2) {
        return res.status(400).json({ message: "Company name must be at least 2 characters" });
    }

    // Headline validation
    if (headline !== undefined && headline !== null) {
        const trimmedHeadline = headline.trim();
        if (trimmedHeadline.length > 120) {
            return res.status(400).json({ message: "Headline must be 120 characters or less" });
        }
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC Check (MANAGE_COMPANY_DETAILS)
        const canEdit = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You do not have permission to update company details");

        // 2. Update
        const updateQuery = `
            UPDATE companies 
            SET name = $1, 
                slogan = $2,
                industry = $3, 
                size = $4, 
                website = $5, 
                location = $6, 
                description = $7, 
                logo_url = COALESCE($8, logo_url), 
                cover_url = COALESCE($9, cover_url),
                headline = $10,
                updated_at = NOW()
            WHERE company_id = $11
            RETURNING *
        `;

        const result = await client.query(updateQuery, [
            name, slogan, industry, size, website, location, description, logo_url, cover_url, headline ? headline.trim() : null, companyId
        ]);

        const updatedCompany = result.rows[0];

        // 3. Audit Log
        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'UPDATE',
            metadata: { changes: req.body } // Simplified metadata
        });

        await client.query("COMMIT");

        res.json({ message: "Company updated successfully", company: updatedCompany });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Update company error:", err);
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

exports.inviteMember = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { email, role } = req.body; // Role name (e.g. "Editor")

    if (!email || !role) {
        return res.status(400).json({ message: "Valid email and role are required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Permission Check
        const canInvite = await checkCompanyPermission(client, companyId, userId, 'INVITE_MEMBERS');
        if (!canInvite) throw new Error("Forbidden: You do not have permission to invite members");

        // 2. Role Escalation Check
        // Get inviter's priority
        const inviterRes = await client.query(
            `SELECT cr.priority FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id 
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );
        const inviterPriority = inviterRes.rows[0]?.priority || 0;

        // Get target role priority
        const targetRoleQuery = await client.query(
            `SELECT role_id, priority FROM company_roles WHERE company_id = $1 AND name ILIKE $2`,
            [companyId, role]
        );
        if (targetRoleQuery.rowCount === 0) throw new Error("Invalid role specified");

        const targetRoleData = targetRoleQuery.rows[0];
        if (targetRoleData.priority > inviterPriority) {
            throw new Error("You cannot assign a role with higher priority than your own.");
        }

        // 3. Rate Limit
        const rateLimitRes = await client.query(
            `SELECT COUNT(*) FROM company_invites 
             WHERE company_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
            [companyId]
        );
        if (parseInt(rateLimitRes.rows[0].count) >= 20) { // Increased limit
            throw new Error("Rate limit exceeded: Max 20 invites per day per company.");
        }

        // 4. Create Invite
        const token = require('crypto').randomBytes(20).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await client.query(
            `INSERT INTO company_invites (company_id, inviter_id, email, role, role_id, token, expires_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
             ON CONFLICT (company_id, email) 
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
                `SELECT name FROM companies WHERE company_id = $1`, [companyId]
            );
            const inviterDetailsRes = await pool.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]
            );
            const companyName = companyRes.rows[0]?.name || 'a company';
            const inviterName = inviterDetailsRes.rows[0]?.full_name || 'Someone';
            const inviterAvatar = inviterDetailsRes.rows[0]?.avatar_url;

            if (invitedUserRes.rowCount > 0) {
                userFound = true;
                const targetUserId = invitedUserRes.rows[0].user_id;
                const notifText = `${inviterName} invited you to join ${companyName} as ${role}`;

                // Persist notification
                const notifRes = await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                     VALUES ($1, $2, 'company_invite', $3, $4, $5) RETURNING notification_id, created_at`,
                    [targetUserId, userId, notifText, companyId,
                        JSON.stringify({ token, companyId, companyName, role, inviteLink })]
                );

                // Real-time socket push (include actor_* fields for popover rendering)
                socketService.notifyUser(targetUserId, "notification", {
                    type: "company_invite",
                    text: notifText,
                    from: userId,
                    sender_id: userId,
                    senderName: inviterName,
                    senderAvatar: inviterAvatar,
                    actor_name: inviterName,
                    actor_avatar: inviterAvatar,
                    referenceId: companyId,
                    reference_id: companyId,
                    metadata: { token, companyId, companyName, role, inviteLink },
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
            inviteLink,
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

exports.verifyDomain = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { domain, otp } = req.body; // e.g. "walstartech.com", otp optional for initial request

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC (OWNER ONLY)
        const isOwner = await checkCompanyPermission(client, companyId, userId, '*');
        if (!isOwner) throw new Error("Forbidden: Only OWNER can verify domain");

        // PHASE 2: Verify OTP if provided
        if (otp) {
            const verifyRes = await client.query(
                `SELECT * FROM company_verifications 
                 WHERE company_id = $1 AND (otp = $2 OR $2 = '123456') -- Allow Mock OTP
                 AND expires_at > NOW() 
                 AND is_verified = FALSE
                 ORDER BY created_at DESC LIMIT 1`,
                [companyId, otp]
            );

            if (verifyRes.rowCount === 0) {
                throw new Error("Invalid or expired OTP");
            }

            // Mark verified
            await client.query(
                `UPDATE companies SET verification_status = 'DOMAIN_VERIFIED' WHERE company_id = $1`,
                [companyId]
            );
            await client.query(
                `UPDATE company_verifications SET is_verified = TRUE WHERE verification_id = $1`,
                [verifyRes.rows[0].verification_id]
            );

            await logAudit(client, {
                entityId: companyId,
                actorId: userId,
                action: 'DOMAIN_VERIFIED',
                metadata: { domain }
            });

            await client.query("COMMIT");
            return res.json({ message: "Domain verified successfully!" });
        }

        // PHASE 1: Generate OTP (Existing Logic)

        // 2. Check Domain Uniqueness (Soft rule)
        const domainParam = `%${domain}%`;
        const dupCheck = await client.query(
            `SELECT 1 FROM companies 
             WHERE verification_status = 'DOMAIN_VERIFIED' 
               AND website ILIKE $1 
               AND company_id != $2`,
            [domainParam, companyId]
        );
        if (dupCheck.rowCount > 0) {
            console.warn(`Soft rule warning: Domain ${domain} already verified for another company.`);
        }

        // 3. Generate Mock OTP
        const newOtp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

        await client.query(
            `INSERT INTO company_verifications (company_id, otp, expires_at) VALUES ($1, $2, $3)`,
            [companyId, newOtp, expiresAt]
        );

        // Update status to PENDING
        await client.query(
            `UPDATE companies SET verification_status = 'DOMAIN_PENDING' WHERE company_id = $1`,
            [companyId]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'VERIFY_INITIATED',
            metadata: { domain }
        });

        await client.query("COMMIT");

        console.log(`[VERIFICATION HOOK] OTP for ${domain}: ${newOtp}`);

        res.json({ message: "Verification OTP sent", otp: newOtp });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Verify domain error:", err);
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

exports.acceptInvite = async (req, res) => {
    const { token } = req.body;
    const userId = req.user.sub; // User accepting the invite

    if (!token) return res.status(400).json({ message: "Token is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Find Invite
        const inviteRes = await client.query(
            `SELECT * FROM company_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > NOW()`,
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
            `SELECT cr.name as role FROM company_members cm JOIN company_roles cr ON cm.role_id = cr.role_id WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [invite.company_id, userId]
        );

        if (memberCheck.rowCount > 0) {
            const existingRole = memberCheck.rows[0].role;
            if (existingRole === 'Owner') { // Changed from 'OWNER' to 'Owner' to match case in roles array
                throw new Error("You are the OWNER of this company. You cannot accept an invitation.");
            } else {
                throw new Error(`You are already a member as ${existingRole}.`);
            }
        }

        // 3. Add to Members
        // Use role_id from invite if available, fallback to lookup
        let roleId = invite.role_id;
        if (!roleId) {
            const roleRes = await client.query(`SELECT role_id FROM company_roles WHERE company_id = $1 AND name ILIKE $2`, [invite.company_id, invite.role]);
            roleId = roleRes.rows[0]?.role_id;
        }

        if (roleId) {
            await client.query(
                `INSERT INTO company_members (company_id, user_id, role_id) VALUES ($1, $2, $3)
                 ON CONFLICT (company_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
                [invite.company_id, userId, roleId]
            );
        } else {
            // Fallback for very old invites? Should not happen with fresh migration
            throw new Error("Invalid role configuration for this invite.");
        }

        // 4. Update Invite Status
        await client.query(
            `UPDATE company_invites SET status = 'ACCEPTED', updated_at = NOW() WHERE invite_id = $1`,
            [invite.invite_id]
        );

        await logAudit(client, {
            entityId: invite.company_id,
            actorId: userId,
            action: 'JOIN_COMPANY',
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

exports.transferOwnership = async (req, res) => {
    const { companyId } = req.params;
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
        const isOwner = await checkCompanyPermission(client, companyId, userId, '*');
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
        const rolesRes = await client.query(`SELECT role_id, name FROM company_roles WHERE company_id = $1 AND name IN ('Owner', 'Admin')`, [companyId]);
        const ownerRole = rolesRes.rows.find(r => r.name === 'Owner');
        const adminRole = rolesRes.rows.find(r => r.name === 'Admin');

        if (!ownerRole || !adminRole) throw new Error("System roles missing");

        // Demote current OWNER to ADMIN
        await client.query(
            `UPDATE company_members SET role_id = $1 WHERE company_id = $2 AND user_id = $3`,
            [adminRole.role_id, companyId, userId]
        );

        // Promote new user to OWNER
        const memberCheck = await client.query(
            `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, newOwnerId]
        );

        if (memberCheck.rowCount > 0) {
            await client.query(
                `UPDATE company_members SET role_id = $1 WHERE company_id = $2 AND user_id = $3`,
                [ownerRole.role_id, companyId, newOwnerId]
            );
        } else {
            await client.query(
                `INSERT INTO company_members (company_id, user_id, role_id) VALUES ($1, $2, $3)`,
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

exports.deleteCompany = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC (OWNER ONLY - MANAGE_COMPANY is required, but deleting is likely OWNER only)
        // Since delete is extremely sensitive, we use checkCompanyPermission for a wildcard meaning or specific logic.
        // Actually, for deleteCompany, let's keep it strictly to Owner role name for safety, but checkCompanyPermission doesn't do name matching anymore.
        // Let's use checkCompanyPermission('*') which only Owner has.
        const isOwner = await checkCompanyPermission(client, companyId, userId, '*');
        if (!isOwner) throw new Error("Forbidden: Only OWNER can delete company");

        const { password } = req.body;
        if (!password) {
            throw new AppError("Password is required to delete a company", 400);
        }

        // Verify password
        const userRes = await client.query("SELECT password_hash FROM users WHERE user_id = $1", [userId]);
        const { comparePassword } = require("../../core/utils/password");
        const isValid = await comparePassword(password, userRes.rows[0].password_hash);
        if (!isValid) throw new AppError("Invalid password", 401);

        // 2. Soft Delete
        await client.query(
            `UPDATE companies SET is_deleted = TRUE, deleted_at = NOW() WHERE company_id = $1`,
            [companyId]
        );

        // Lifecycle: End all active sessions for this company
        await chatSessionCtrl.endAllSessionsForCompany(client, companyId, userId);

        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'DELETE',
            metadata: {}
        });

        await client.query("COMMIT");
        res.json({ message: "Company deleted successfully" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Delete company error:", err);
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

exports.getMembers = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { page = 1, limit = 10, status } = req.query;
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
        // Permission Check
        const canView = await checkCompanyPermission(client, companyId, userId, 'VIEW_MEMBERS');
        if (!canView) return res.status(403).json({ message: "Forbidden" });

        // Build Query
        let whereClause = `WHERE cm.company_id = $1`;
        const params = [companyId, limit, offset];
        if (status) {
            whereClause += ` AND cm.status = $4`;
            params.push(status);
        }

        const countRes = await client.query(
            `SELECT COUNT(*) FROM company_members cm ${whereClause}`,
            status ? [companyId, status] : [companyId]
        );
        const total = parseInt(countRes.rows[0].count);

        const result = await client.query(
            `SELECT 
                u.user_id, u.full_name, u.email, u.avatar_url, 
                cr.name as role, cr.color as role_color, cr.priority,
                cm.joined_at, cm.status, cm.expires_at,
                cm.is_primary_display
             FROM company_members cm
             JOIN users u ON cm.user_id = u.user_id
             JOIN company_roles cr ON cm.role_id = cr.role_id
             ${whereClause}
             ORDER BY cr.priority DESC, cm.joined_at ASC
             LIMIT $2 OFFSET $3`,
            params
        );

        res.json({
            data: result.rows,
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
    const { companyId, memberId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Check requester role (REMOVE_MEMBERS)
        const canRemove = await checkCompanyPermission(client, companyId, userId, 'REMOVE_MEMBERS');
        if (!canRemove) throw new Error("Forbidden: You cannot remove members");

        // 2. Check target member role
        const targetRes = await client.query(
            `SELECT cr.name as role, cr.priority FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, memberId]
        );
        if (targetRes.rowCount === 0) throw new Error("Member not found");
        const targetRole = targetRes.rows[0].role;
        const targetPriority = targetRes.rows[0].priority;

        // 3. Enforce Hierarchy
        // Look up requester priority
        const requesterRes = await client.query(
            `SELECT cr.priority FROM company_members cm 
             JOIN company_roles cr ON cm.role_id = cr.role_id
             WHERE cm.company_id = $1 AND cm.user_id = $2`,
            [companyId, userId]
        );
        const requesterPriority = requesterRes.rows[0].priority;

        if (targetPriority >= requesterPriority) {
            throw new Error("You cannot remove a member with equal or higher priority.");
        }

        // 4. Remove
        await client.query(
            `DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`,
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

exports.leaveCompany = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Check existence and role
        const resRole = await client.query(
            `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, userId]
        );
        if (resRole.rowCount === 0) throw new Error("You are not a member of this company");
        const role = resRole.rows[0].role;

        // 2. OWNER cannot leave
        if (role === 'OWNER') throw new Error("OWNER cannot leave. Transfer ownership first.");

        // 3. Leave
        await client.query(
            `DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, userId]
        );

        await logAudit(client, {
            entityId: companyId,
            actorId: userId, // Self-action
            action: 'LEAVE_COMPANY',
            metadata: { role }
        });

        await client.query("COMMIT");
        res.json({ message: "You have left the company" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Leave company error:", err);
        if (err.message.startsWith("OWNER")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getUserCompanies = async (req, res) => {
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT c.*, 
             json_build_object(
                'name', cr.name,
                'permissions', cr.permissions,
                'priority', cr.priority
             ) as viewer_role_data,
             cr.name as role -- Keep for backward compatibility if needed, or use cr.name
             FROM companies c
             JOIN company_members cm ON c.company_id = cm.company_id
             LEFT JOIN company_roles cr ON cm.role_id = cr.role_id
             WHERE cm.user_id = $1 AND c.is_deleted = FALSE AND cm.status = 'ACTIVE'
             ORDER BY c.created_at DESC`,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get user companies error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// --- Tech Stack ---

exports.getTechStack = async (req, res) => {
    const { slug } = req.params;
    try {
        const result = await pool.query(
            `SELECT t.* FROM company_tech_stack t
             JOIN companies c ON t.company_id = c.company_id
             WHERE c.slug = $1
             ORDER BY t.created_at ASC`,
            [slug]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get tech stack error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.addTechStack = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { name, category } = req.body;

    if (!name) return res.status(400).json({ message: "Technology name is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit company profile");

        const result = await client.query(
            `INSERT INTO company_tech_stack (company_id, name, category)
             VALUES ($1, $2, $3)
             ON CONFLICT (company_id, name) DO NOTHING
             RETURNING *`,
            [companyId, name, category || 'Other']
        );

        // If row already exists, just return success or fetch it
        if (result.rowCount === 0) {
            const existing = await client.query(
                `SELECT * FROM company_tech_stack WHERE company_id = $1 AND name = $2`,
                [companyId, name]
            );
            await client.query("COMMIT");
            return res.json(existing.rows[0]);
        }

        await client.query("COMMIT");
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Add tech stack error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.removeTechStack = async (req, res) => {
    const { companyId, stackId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit company profile");

        await client.query(
            `DELETE FROM company_tech_stack WHERE company_id = $1 AND stack_id = $2`,
            [companyId, stackId]
        );

        await client.query("COMMIT");
        res.json({ message: "Removed successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Remove tech stack error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// --- Gallery ---

exports.getGallery = async (req, res) => {
    const { slug } = req.params;
    try {
        const result = await pool.query(
            `SELECT g.* FROM company_gallery g
             JOIN companies c ON g.company_id = c.company_id
             WHERE c.slug = $1
             ORDER BY g.created_at DESC`,
            [slug]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get gallery error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.addToGallery = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { url, type, caption } = req.body;

    if (!url) return res.status(400).json({ message: "URL is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit company profile");

        const result = await client.query(
            `INSERT INTO company_gallery (company_id, url, type, caption)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [companyId, url, type || 'image', caption]
        );

        await client.query("COMMIT");
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Add gallery error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.removeFromGallery = async (req, res) => {
    const { companyId, galleryId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit company profile");

        await client.query(
            `DELETE FROM company_gallery WHERE company_id = $1 AND gallery_id = $2`,
            [companyId, galleryId]
        );

        await client.query("COMMIT");
        res.json({ message: "Removed successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Remove gallery error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.notifyEmployees = async (req, res) => {
    const { companyId, postId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canNotify = await checkCompanyPermission(client, companyId, userId, 'MANAGE_COMPANY');
        if (!canNotify) throw new Error("Forbidden: You cannot notify employees");

        // 1. Get Company Name
        const companyRes = await client.query('SELECT name FROM companies WHERE company_id = $1', [companyId]);
        const companyName = companyRes.rows[0].name;

        // 2. Get all employees (excluding the sender)
        const employeesRes = await client.query(
            `SELECT user_id FROM company_members WHERE company_id = $1 AND user_id != $2`,
            [companyId, userId]
        );
        const employees = employeesRes.rows;

        if (employees.length === 0) {
            await client.query("COMMIT");
            return res.json({ message: "No other employees to notify", count: 0 });
        }

        // 3. Create Notifications
        const notificationText = `${companyName} invites you to share their new post.`;
        const notificationType = 'advocacy';

        for (const emp of employees) {
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [emp.user_id, userId, notificationType, notificationText, postId, { companyId }]
            );
        }

        await client.query("COMMIT");
        res.json({ message: "Notifications sent", count: employees.length });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Notify employees error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getCompanyPosts = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user ? req.user.sub : null; // Can be guest theoretically, but middleware might enforce auth
    const {
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
    } = req.query;

    try {
        const params = [companyId];
        let idx = 2;
        let whereClause = `WHERE p.author_company_id = $1`;

        // We can expose a userId param for "is_liked" check even if public
        // For now, let's assume req.user is populated if authenticated

        if (userId) {
            params.push(userId); // $2
            idx++;
        } else {
            params.push(null); // $2 dummy
            idx++;
        }
        const userParamIdx = 2; // Fixed index for user_id in this specific query construction

        // 1. Cursor handling
        if (cursorCreatedAt && cursorPostId) {
            whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})`;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        // 2. Limit
        params.push(limit);

        const query = `
        SELECT
            p.post_id,
            p.content,
            p.created_at,
            p.visibility,

            -- Author is always the company here
            comp.company_id AS author_id, -- Mapped to author_id for frontend compatibility
            comp.name AS author_name,
            comp.logo_url AS author_avatar,
            comp.slug AS author_slug,
            true AS is_company_post,

            pc.name AS category_name,

            COALESCE(pm.media, '[]'::json) AS media,
            COALESCE(lc.like_count, 0)::int AS like_count,
            COALESCE(cc.comment_count, 0)::int AS comment_count,
            EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $${userParamIdx}) AS is_liked,

            pp.poll,

            -- Shared Post Data
            CASE 
                WHEN p.shared_post_id IS NULL THEN NULL
                WHEN sp.post_id IS NULL THEN 
                    json_build_object('is_accessible', false, 'reason', 'deleted')
                ELSE
                    json_build_object(
                        'is_accessible', true,
                        'post_id', sp.post_id,
                        'content', sp.content,
                        'created_at', sp.created_at,
                        'author', json_build_object(
                             'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                             'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                             'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                             'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                             'is_company_post', (sp.author_company_id IS NOT NULL)
                        ),
                        'media', COALESCE(sp_media.media, '[]'::json),
                        'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                        'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                         'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $${userParamIdx})
                    )
            END AS shared_post

        FROM posts p
        JOIN companies comp ON comp.company_id = p.author_company_id
        LEFT JOIN post_categories pc ON pc.category_id = p.category_id

         -- Media
        LEFT JOIN (
            SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
            FROM post_media GROUP BY post_id
        ) pm ON pm.post_id = p.post_id

        -- Likes
        LEFT JOIN (
            SELECT post_id, COUNT(*) AS like_count FROM post_likes GROUP BY post_id
        ) lc ON lc.post_id = p.post_id

        -- Comments
        LEFT JOIN (
            SELECT post_id, COUNT(*) AS comment_count FROM post_comments GROUP BY post_id
        ) cc ON cc.post_id = p.post_id

        -- Polls
        LEFT JOIN (
             SELECT pp.post_id, json_build_object(
                'poll_id', pp.poll_id,
                'duration', COALESCE(pp.duration, '1 day'),
                'total_votes', COALESCE(pv.total_votes, 0),
                'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx}),
                'options', COALESCE(po.options, '[]'::json),
                'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW())
             ) AS poll
             FROM post_polls pp
             LEFT JOIN (
                SELECT poll_id, json_agg(json_build_object('option_id', option_id, 'option_text', option_text, 'vote_count', vote_count)) AS options
                FROM (
                    SELECT po.option_id, po.poll_id, po.option_text, COUNT(pv.vote_id) AS vote_count
                    FROM poll_options po
                    LEFT JOIN poll_votes pv ON pv.option_id = po.option_id
                    GROUP BY po.option_id
                ) t GROUP BY poll_id
             ) po ON po.poll_id = pp.poll_id
             LEFT JOIN (SELECT poll_id, COUNT(*) as total_votes FROM poll_votes GROUP BY poll_id) pv ON pv.poll_id = pp.poll_id
        ) pp ON pp.post_id = p.post_id

        -- Shared Post Joins
        LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
        LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
        LEFT JOIN companies sp_comp ON sp_comp.company_id = sp.author_company_id
        LEFT JOIN (
             SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
             FROM post_media GROUP BY post_id
        ) sp_media ON sp.post_id = sp_media.post_id

        ${whereClause}
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${idx}
        `;

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        res.json({
            posts: rows,
            nextCursor: last ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id } : null
        });

    } catch (err) {
        console.error("Get company posts error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.uploadLogo = async (req, res) => {
    const { companyId } = req.params;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const logoUrl = req.file.path;
        await client.query(`UPDATE companies SET logo_url = $1 WHERE company_id = $2`, [logoUrl, companyId]);

        await logAudit(client, {
            entityId: companyId,
            actorId: req.user.sub,
            action: 'UPDATE_LOGO',
            metadata: { url: logoUrl }
        });

        await client.query("COMMIT");
        res.json({ message: "Logo updated", url: logoUrl });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Upload logo error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.uploadCover = async (req, res) => {
    const { companyId } = req.params;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const coverUrl = req.file.path;
        await client.query(`UPDATE companies SET cover_url = $1 WHERE company_id = $2`, [coverUrl, companyId]);

        await logAudit(client, {
            entityId: companyId,
            actorId: req.user.sub,
            action: 'UPDATE_COVER',
            metadata: { url: coverUrl }
        });

        await client.query("COMMIT");
        res.json({ message: "Cover updated", url: coverUrl });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Upload cover error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteLogo = async (req, res) => {
    const { companyId } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`UPDATE companies SET logo_url = NULL WHERE company_id = $1`, [companyId]);

        await logAudit(client, {
            entityId: companyId,
            actorId: req.user.sub,
            action: 'DELETE_LOGO',
            metadata: {}
        });

        await client.query("COMMIT");
        res.json({ message: "Logo deleted" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Delete logo error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteCover = async (req, res) => {
    const { companyId } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`UPDATE companies SET cover_url = NULL WHERE company_id = $1`, [companyId]);

        await logAudit(client, {
            entityId: companyId,
            actorId: req.user.sub,
            action: 'DELETE_COVER',
            metadata: {}
        });

        await client.query("COMMIT");
        res.json({ message: "Cover deleted" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Delete cover error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// --- Notification Preferences ---

exports.getNotificationPreferences = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT events_enabled, jobs_enabled, posts_enabled, updated_at
             FROM company_notification_preferences
             WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );

        if (result.rowCount === 0) {
            // Return defaults (all ON) if no preferences set yet
            return res.json({
                events_enabled: true,
                jobs_enabled: true,
                posts_enabled: true,
                is_default: true,
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Get notification preferences error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateNotificationPreferences = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { events_enabled, jobs_enabled, posts_enabled } = req.body;

    try {
        // Verify user follows the company
        const followCheck = await pool.query(
            `SELECT 1 FROM company_followers WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );

        if (followCheck.rowCount === 0) {
            return res.status(403).json({ message: "You must follow this company to set notification preferences" });
        }

        // Upsert preferences
        const result = await pool.query(
            `INSERT INTO company_notification_preferences (user_id, company_id, events_enabled, jobs_enabled, posts_enabled)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, company_id)
             DO UPDATE SET
                events_enabled = COALESCE($3, company_notification_preferences.events_enabled),
                jobs_enabled = COALESCE($4, company_notification_preferences.jobs_enabled),
                posts_enabled = COALESCE($5, company_notification_preferences.posts_enabled),
                updated_at = NOW()
             RETURNING *`,
            [userId, companyId, events_enabled, jobs_enabled, posts_enabled]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Update notification preferences error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
