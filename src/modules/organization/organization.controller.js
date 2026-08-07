const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { checkOrgPermission } = require("../../core/utils/rbac");
const { wouldCreateCycle } = require("./organization.hierarchy.controller");

const { logAudit } = require("../../core/infrastructure/audit.service");

// Helper: checkRole was removed in favor of checkCompanyPermission

// --- Updated Permissions Helper ---
const { requireOrgPermission } = require("../../core/middlewares/organization.auth.middleware");

exports.createOrganization = async (req, res) => {
    const userId = req.user.sub;
    const { name, slug, email, industry, size, website, location, description, parent_org_id } = req.body;

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
            throw new AppError("Rate limit exceeded: You can only create 3 organizations per day.", 429);
        }

        // 2b. Max Active Companies Limit (5)
        const activeRes = await client.query(
            `SELECT COUNT(*) FROM organization_members om
             JOIN organization_roles oroles ON om.role_id = oroles.role_id
             WHERE om.user_id = $1 AND oroles.name = 'Owner'`,
            [userId]
        );
        if (parseInt(activeRes.rows[0].count) >= 5) {
            throw new AppError("Limit reached: You can own a maximum of 5 organizations.", 429);
        }

        // 3. Normalized Unique Check
        const slugCheck = await client.query(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
        if (slugCheck.rowCount > 0) {
            throw new Error("Slug already taken");
        }

        // Check if slug is reserved/soft-deleted (within 30 days) - OPTIONAL based on requirement "Prevent slug reuse for 30 days"
        // The soft delete implementation keeps the row, so the unique constraint on slug might conflict if we don't handle it.
        // However, the requirement says "Prevent slug reuse", so uniqueness on slug (even deleted ones) corresponds to this.
        // If we wanted to allow reuse after 30 days, we'd need partial index or move deleted to archive.
        // For MVP, unique constraint on main table holds.

        // 4. Create Organization (Company or Institution)
        const entityType = req.body.entity_type === 'INSTITUTION' ? 'INSTITUTION' : 'COMPANY';

        // 4a. Validate parent_org_id if provided
        if (parent_org_id) {
            const parentRes = await client.query(
                `SELECT org_id, is_deleted, parent_org_id FROM organizations WHERE org_id = $1`,
                [parent_org_id]
            );
            if (parentRes.rowCount === 0 || parentRes.rows[0].is_deleted) {
                throw new AppError('Parent organization not found', 404);
            }
            if (parentRes.rows[0].parent_org_id) {
                throw new AppError('The target organization is already a sub-organization. Nesting beyond one level is not supported.', 400);
            }
        }

        const insertCompanyText = `
      INSERT INTO organizations (name, slug, email, industry, size, website, location, description, slogan, entity_type, parent_org_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
        const companyRes = await client.query(insertCompanyText, [
            name, slug, email, industry, size, website, location, description, req.body.slogan, entityType,
            parent_org_id || null
        ]);
        const company = companyRes.rows[0];

        // 5. Add Creator as Primary Admin/Owner role (only seed this single role)
        let roles;
        let ownerRoleName;

        ownerRoleName = 'Admin';
        roles = [
            { name: 'Admin', color: '#FFD700', permissions: ["*"], priority: 100, is_system: true }
        ];

        let ownerRoleId;

        for (const r of roles) {
            const rRes = await client.query(
                `INSERT INTO organization_roles (org_id, name, color, permissions, priority, is_system_role)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING role_id`,
                [company.org_id, r.name, r.color, JSON.stringify(r.permissions), r.priority, r.is_system]
            );
            if (r.name === ownerRoleName) ownerRoleId = rRes.rows[0].role_id;
        }

        await client.query(
            `INSERT INTO organization_members (org_id, user_id, role_id, is_core_team) VALUES ($1, $2, $3, TRUE)`,
            [company.org_id, userId, ownerRoleId]
        );

        // 6. Audit Log
        await logAudit(client, {
            entityId: company.org_id,
            actorId: userId,
            actorRole: ownerRoleName,
            action: 'CREATE_PAGE',
            metadata: { name, slug, targetType: 'organization', targetId: company.org_id, targetName: name }
        });

        await client.query("COMMIT");

        res.status(201).json({ message: "Organization created successfully", organization: company });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Create organization error:", err);
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
            `SELECT 1 FROM organizations WHERE slug = $1`,
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

exports.getOrganization = async (req, res) => {
    const { slug } = req.params;
    const userId = req.user?.sub; // Optional

    try {
        const result = await pool.query(
            `SELECT c.*,
        (SELECT COUNT(*) FROM organization_members cm WHERE cm.org_id = c.org_id) as member_count,
        ${userId ? `(
            SELECT json_build_object(
                'name', cr.name,
                'description', cr.description,
                'permissions', cr.permissions,
                'priority', cr.priority
            )
            FROM organization_members cm 
            JOIN organization_roles cr ON cm.role_id = cr.role_id 
            WHERE cm.org_id = c.org_id AND cm.user_id = $2
        ) as viewer_role_data` : 'NULL as viewer_role_data'},
        CASE WHEN p.org_id IS NOT NULL THEN
            json_build_object(
                'org_id',   p.org_id,
                'name',     p.name,
                'slug',     p.slug,
                'logo_url', p.logo_url,
                'entity_type', p.entity_type
            )
        ELSE NULL END AS parent_org,
        (SELECT COUNT(*) FROM organizations ch WHERE ch.parent_org_id = c.org_id AND ch.is_deleted = FALSE) AS children_count
       FROM organizations c
       LEFT JOIN organizations p ON c.parent_org_id = p.org_id
       WHERE (c.slug = $1 OR (
           $1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' 
           AND c.org_id = $1::uuid
       )) AND c.is_deleted = FALSE`,
            userId ? [slug, userId] : [slug]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }

        const company = result.rows[0];

        // Unified Profile View Tracking (Redis + Atomic DB)
        if (userId && company.org_id) {
            const dashboardService = require("../dashboard/dashboard.service");
            // Fire and forget to keep response fast
            dashboardService.addProfileView(userId, company.org_id, 'organization')
                .catch(err => console.error("Error recording organization profile view:", err));
        }

        // Audit Log for Analytics (Log only external non-member views)
        if (userId && company.org_id) {
            (async () => {
                const auditClient = await pool.connect();
                try {
                    // Check if viewer is an active team member of this org
                    const memberCheck = await auditClient.query(
                        `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                        [company.org_id, userId]
                    );

                    // Skip logging if user is an active team member of their own org
                    if (memberCheck.rowCount > 0) return;

                    // Refinement: Debounce VIEW logs (5 seconds cooldown)
                    const lastViewRes = await auditClient.query(
                        `SELECT created_at FROM audit_logs 
                         WHERE entity_id = $1 AND entity_type = 'ORGANIZATION' AND actor_id = $2 AND action = 'VIEW' 
                         ORDER BY created_at DESC LIMIT 1`,
                        [company.org_id, userId]
                    );

                    let shouldLog = true;
                    if (lastViewRes.rowCount > 0) {
                        const lastViewTime = new Date(lastViewRes.rows[0].created_at).getTime();
                        const timeDiff = Date.now() - lastViewTime;
                        if (timeDiff < 5 * 1000) { // 5 seconds debounce
                            shouldLog = false;
                        }
                    }

                    if (shouldLog) {
                        await logAudit(auditClient, {
                            entityId: company.org_id,
                            actorId: userId,
                            action: 'VIEW',
                            metadata: { source: 'profile_page' }
                        });
                    }
                } catch (e) { console.error("Audit log error:", e); }
                finally { auditClient.release(); }
            })();
        }

        // Privacy & Permission Key Calculations + Zero Network Data Leak Stripping
        const privacyRes = await pool.query(
            `SELECT show_email, show_phone, tag_permission, following_visibility, followers_visibility, message_permission
             FROM organization_privacy_settings WHERE org_id = $1`,
            [company.org_id]
        );

        const privacy = privacyRes.rows[0] || {
            show_email: true,
            show_phone: true,
            tag_permission: "everyone",
            following_visibility: "everyone",
            followers_visibility: "everyone",
            message_permission: "everyone",
        };

        // Check if viewer is active team member/owner
        let isTeamMemberOrOwner = false;

        if (userId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [company.org_id, userId]
            );
            isTeamMemberOrOwner = (company.created_by === userId) || (memberCheck.rowCount > 0);
        }

        const isOwnOrgActor = req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId === company.org_id;

        let isFollower = false;
        if (!isOwnOrgActor) {
            if (req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId) {
                const followCheck = await pool.query(
                    `SELECT 1 FROM organization_org_follows WHERE following_org_id = $1 AND follower_org_id = $2`,
                    [company.org_id, req.actor.orgId]
                );
                isFollower = followCheck.rowCount > 0;
            } else if (userId) {
                const followCheck = await pool.query(
                    `SELECT 1 FROM organization_followers WHERE org_id = $1 AND user_id = $2`,
                    [company.org_id, userId]
                );
                isFollower = followCheck.rowCount > 0;
            }
        }

        const canViewEmail = isOwnOrgActor ? true : (privacy.show_email ?? true);
        const canViewPhone = isOwnOrgActor ? true : (privacy.show_phone ?? true);

        const showMessage = isOwnOrgActor ? false : (privacy.message_permission === 'everyone' || (privacy.message_permission === 'followers_only' && isFollower));
        const showFollowersList = isOwnOrgActor ? true : (privacy.followers_visibility === 'everyone' || (privacy.followers_visibility === 'followers_only' && isFollower));
        const showFollowingList = isOwnOrgActor ? true : (privacy.following_visibility === 'everyone' || (privacy.following_visibility === 'followers_only' && isFollower));

        // Attach boolean keys for UI
        company.showMessage = showMessage;
        company.showFollowersList = showFollowersList;
        company.showFollowingList = showFollowingList;
        company.tagPermission = privacy.tag_permission || "everyone";
        company.isEmailShow = canViewEmail;
        company.isMobileShow = canViewPhone;
        company.is_email_show = canViewEmail;
        company.is_mobile_show = canViewPhone;

        // ZERO NETWORK DATA LEAK PAYLOAD STRIPPING: If permission denied, strip raw sensitive fields
        if (!canViewEmail) company.email = null;
        if (!canViewPhone) company.phone = null;

        res.json(company);
    } catch (err) {
        console.error("Get organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateOrganization = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { name, slogan, industry, size, website, location, description, logo_url, cover_url, headline } = req.body;

    // Basic validation
    if (!name || name.trim().length < 2) {
        return res.status(400).json({ message: "Organization name must be at least 2 characters" });
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
        const canEdit = await checkOrgPermission(client, orgId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You do not have permission to update organization details");

        // 2. Update
        const updateQuery = `
            UPDATE organizations 
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
            WHERE org_id = $11
            RETURNING *
        `;

        const result = await client.query(updateQuery, [
            name, slogan, industry, size, website, location, description, logo_url, cover_url, headline ? headline.trim() : null, orgId
        ]);

        const updatedCompany = result.rows[0];

        // 3. Audit Log
        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'UPDATE',
            metadata: { changes: req.body } // Simplified metadata
        });

        await client.query("COMMIT");

        res.json({ message: "Organization updated successfully", organization: updatedCompany });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Update organization error:", err);
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

exports.deleteOrganization = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC
        const isOwner = await checkOrgPermission(client, orgId, userId, '*');

        // Diagnostic Logging
        console.log(`[DeleteOrg] Attempt: orgId=${orgId}, userId=${userId}, isOwner=${isOwner}`);

        if (!isOwner) throw new Error("Forbidden: Only authorized administrators (Owner/Admin) can delete this organization");

        const { password } = req.body;
        if (!password) {
            throw new AppError("Password is required to delete an organization", 400);
        }

        // Verify password
        const userRes = await client.query("SELECT password_hash FROM users WHERE user_id = $1", [userId]);
        const { comparePassword } = require("../../core/utils/password");
        const isValid = await comparePassword(password, userRes.rows[0].password_hash);
        if (!isValid) throw new AppError("Invalid password", 401);

        const orgRes = await client.query("SELECT name FROM organizations WHERE org_id = $1", [orgId]);
        if (orgRes.rowCount === 0) throw new AppError("Organization not found", 404);
        const orgName = orgRes.rows[0].name;

        // 2a. Nullify children's parent reference before soft-deleting
        // Keeps children as independent top-level orgs rather than orphaning them.
        await client.query(
            `UPDATE organizations SET parent_org_id = NULL, updated_at = NOW() WHERE parent_org_id = $1`,
            [orgId]
        );

        // 2b. Create Deletion Batch
        const batchRes = await client.query(
            `INSERT INTO deletion_batches (created_by, type) VALUES ($1, 'STANDALONE_COMPANY') RETURNING batch_id`,
            [userId]
        );
        const batchId = batchRes.rows[0].batch_id;

        // 2c. Schedule soft deletion
        const deletionExecuteAt = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
        await client.query(
            `UPDATE organizations 
             SET is_deleted = TRUE, deleted_at = NOW(), deletion_scheduled_at = NOW(), deletion_execute_at = $1, deletion_batch_id = $2
             WHERE org_id = $3`,
            [deletionExecuteAt, batchId, orgId]
        );

        // 2d. Generate restoration token
        const crypto = require("crypto");
        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

        await client.query(
            `INSERT INTO organization_restoration_tokens (org_id, token_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [orgId, tokenHash, deletionExecuteAt]
        );

        // Lifecycle: End all active sessions for this company
        const chatSessionCtrl = require("../messaging/chatSession.controller");
        await chatSessionCtrl.endAllSessionsForOrganization(client, orgId, userId);

        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'DELETE',
            metadata: {}
        });

        // Send recovery email (non-blocking)
        const userEmailRes = await client.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        const emailService = require("../../core/services/email.service");
        emailService.sendOrganizationDeletionEmail(
            userEmailRes.rows[0].email,
            orgName,
            rawToken,
            deletionExecuteAt
        ).catch(err => console.error("[DeleteOrg] Failed to send recovery email:", err));

        await client.query("COMMIT");

        // Broadcast real-time socket event to all organization members
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            const membersRes = await pool.query(`SELECT user_id FROM organization_members WHERE org_id = $1`, [orgId]);
            for (const m of membersRes.rows) {
                socketService.notifyUser(m.user_id, 'org_status_changed', { orgId, status: 'deleted', action: 'deleted' });
            }
        } catch (sErr) {
            console.error("[DeleteOrg] Socket notification error:", sErr);
        }

        res.json({ 
            message: "Organization scheduled for deletion. Check your email for a recovery link.",
            deletionDate: deletionExecuteAt
        });


    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Delete organization error:", err);
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

const maskEmail = (email) => {
    if (!email || !email.includes('@')) return '';
    const [name, domain] = email.split('@');
    if (name.length <= 2) return `${name.charAt(0)}***@${domain}`;
    return `${name.charAt(0)}***${name.charAt(name.length - 1)}@${domain}`;
};

exports.sendDeleteOrgOTP = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        // 1. Check Owner/Admin Permission
        const isOwner = await checkOrgPermission(client, orgId, userId, '*');
        if (!isOwner) {
            throw new AppError("Forbidden: Only authorized administrators (Owner/Admin) can delete this organization", 403);
        }

        // 2. Fetch Organization Details
        const orgRes = await client.query(
            "SELECT name, email, created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            throw new AppError("Organization not found", 404);
        }
        const org = orgRes.rows[0];

        // 3. Fetch Owner User Details
        const ownerRes = await client.query(
            "SELECT email FROM users WHERE user_id = $1",
            [org.created_by || userId]
        );
        const ownerEmail = ownerRes.rows[0]?.email;
        const orgEmail = org.email;

        // Collect all target email addresses (org email + owner email)
        const recipientSet = new Set();
        if (orgEmail && orgEmail.trim()) recipientSet.add(orgEmail.toLowerCase().trim());
        if (ownerEmail && ownerEmail.trim()) recipientSet.add(ownerEmail.toLowerCase().trim());

        const recipients = Array.from(recipientSet);
        if (recipients.length === 0) {
            throw new AppError("No registered email address found for this organization or owner", 400);
        }

        const primaryEmail = recipients[0];

        // 4. Rate Limit & Cooldown Check (from email_otps table)
        const existing = await client.query(
            `SELECT created_at, request_count FROM email_otps WHERE email = $1`,
            [primaryEmail]
        );

        if (existing.rowCount > 0) {
            const record = existing.rows[0];
            const diffSeconds = (new Date() - new Date(record.created_at)) / 1000;
            if (diffSeconds < 5) {
                throw new AppError("A verification code was just requested. Please wait a few seconds before trying again.", 429);
            }
            if (diffSeconds < 60 && record.request_count >= 3) {
                throw new AppError("Too many OTP requests. Please wait a minute before trying again.", 429);
            }
        }

        // 5. Generate & Store OTP
        const { generateSecureOTP } = require("../auth/otp.service");
        const bcrypt = require("bcrypt");
        const otp = generateSecureOTP();
        const otpHash = await bcrypt.hash(otp, 10);
        const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES) || 5;
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000);

        await client.query(
            `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count)
             VALUES ($1, $2, $3, 0, NOW(), 1)
             ON CONFLICT (email)
             DO UPDATE SET
                 otp_hash = EXCLUDED.otp_hash,
                 expires_at = EXCLUDED.expires_at,
                 attempts = 0,
                 created_at = NOW(),
                 request_count = email_otps.request_count + 1`,
            [primaryEmail, otpHash, expiresAt]
        );

        if (recipients.length > 1) {
            await client.query(
                `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count)
                 VALUES ($1, $2, $3, 0, NOW(), 1)
                 ON CONFLICT (email)
                 DO UPDATE SET
                     otp_hash = EXCLUDED.otp_hash,
                     expires_at = EXCLUDED.expires_at,
                     attempts = 0,
                     created_at = NOW(),
                     request_count = email_otps.request_count + 1`,
                [recipients[1], otpHash, expiresAt]
            );
        }

        // 6. Send Email to Recipients
        const emailService = require("../../core/services/email.service");
        await emailService.sendOrgDeleteOTPEmail(recipients, otp, org.name);

        const maskedDisplay = recipients.map(maskEmail).join(", ");
        res.json({
            success: true,
            message: "Verification code sent to organization email",
            email_masked: maskedDisplay,
            expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
            cooldown_seconds: 30
        });
    } catch (err) {
        console.error("Send delete org OTP error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: err.message || "Failed to send verification code" });
    } finally {
        client.release();
    }
};
exports.validateOTPForOrganizationDeletion = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { otp } = req.body;

    if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({ message: "6-digit verification code is required" });
    }

    const client = await pool.connect();
    try {
        // 1. Check Owner/Admin Permission
        const isOwner = await checkOrgPermission(client, orgId, userId, '*');
        if (!isOwner) {
            throw new AppError("Forbidden: Only authorized administrators (Owner/Admin) can delete this organization", 403);
        }

        // 2. Fetch Org & Email Target
        const orgRes = await client.query(
            "SELECT name, email, created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            throw new AppError("Organization not found or already deleted", 404);
        }
        const org = orgRes.rows[0];

        const ownerRes = await client.query(
            "SELECT email FROM users WHERE user_id = $1",
            [org.created_by || userId]
        );
        const ownerEmail = ownerRes.rows[0]?.email;
        const orgEmail = org.email;

        const recipientSet = new Set();
        if (orgEmail && orgEmail.trim()) recipientSet.add(orgEmail.toLowerCase().trim());
        if (ownerEmail && ownerEmail.trim()) recipientSet.add(ownerEmail.toLowerCase().trim());

        const recipients = Array.from(recipientSet);
        if (recipients.length === 0) {
            throw new AppError("No registered email address found for this organization or owner", 400);
        }

        // 3. Verify OTP via otpService (consume = false)
        const { verifyOTP } = require("../auth/otp.service");
        let otpResult = await verifyOTP(recipients[0], otp, false);
        if (otpResult.error && otpResult.error.message.includes("No active OTP found") && recipients.length > 1) {
            otpResult = await verifyOTP(recipients[1], otp, false);
        }

        if (otpResult.error) {
            return res.status(otpResult.error.status || 400).json({ message: otpResult.error.message });
        }

        return res.status(200).json({ success: true, message: "OTP verified successfully" });
    } catch (error) {
        console.error("Error validating OTP for organization deletion:", error);
        res.status(error.status || 500).json({ message: error.message || "Failed to validate OTP" });
    } finally {
        client.release();
    }
};

exports.verifyOTPAndDeleteOrganization = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { otp } = req.body;

    if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({ message: "6-digit verification code is required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Check Owner/Admin Permission
        const isOwner = await checkOrgPermission(client, orgId, userId, '*');
        if (!isOwner) {
            throw new AppError("Forbidden: Only authorized administrators (Owner/Admin) can delete this organization", 403);
        }

        // 2. Fetch Org & Email Target
        const orgRes = await client.query(
            "SELECT name, email, created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            throw new AppError("Organization not found or already deleted", 404);
        }
        const org = orgRes.rows[0];

        const ownerRes = await client.query(
            "SELECT email FROM users WHERE user_id = $1",
            [org.created_by || userId]
        );
        const ownerEmail = ownerRes.rows[0]?.email;
        const orgEmail = org.email;

        const recipientSet = new Set();
        if (orgEmail && orgEmail.trim()) recipientSet.add(orgEmail.toLowerCase().trim());
        if (ownerEmail && ownerEmail.trim()) recipientSet.add(ownerEmail.toLowerCase().trim());

        const recipients = Array.from(recipientSet);
        if (recipients.length === 0) {
            throw new AppError("No registered email address found for this organization or owner", 400);
        }

        // 3. Verify OTP via otpService
        const { verifyOTP } = require("../auth/otp.service");
        let otpResult = await verifyOTP(recipients[0], otp, true);
        if (otpResult.error && otpResult.error.message.includes("No active OTP found") && recipients.length > 1) {
            otpResult = await verifyOTP(recipients[1], otp, true);
        }

        if (otpResult.error) {
            await client.query("ROLLBACK");
            return res.status(otpResult.error.status || 400).json({ message: otpResult.error.message });
        }

        // 4. Soft Delete Execution & Restoration Setup
        // Nullify children's parent reference
        await client.query(
            `UPDATE organizations SET parent_org_id = NULL, updated_at = NOW() WHERE parent_org_id = $1`,
            [orgId]
        );

        // Deletion Batch
        const batchRes = await client.query(
            `INSERT INTO deletion_batches (created_by, type) VALUES ($1, 'STANDALONE_COMPANY') RETURNING batch_id`,
            [userId]
        );
        const batchId = batchRes.rows[0].batch_id;

        // Schedule soft deletion (40 days grace period)
        const deletionExecuteAt = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
        await client.query(
            `UPDATE organizations 
             SET is_deleted = TRUE, deleted_at = NOW(), deletion_scheduled_at = NOW(), deletion_execute_at = $1, deletion_batch_id = $2
             WHERE org_id = $3`,
            [deletionExecuteAt, batchId, orgId]
        );

        // Generate restoration token
        const crypto = require("crypto");
        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

        await client.query(
            `INSERT INTO organization_restoration_tokens (org_id, token_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [orgId, tokenHash, deletionExecuteAt]
        );

        // End active chat/messaging sessions for org
        const chatSessionCtrl = require("../messaging/chatSession.controller");
        await chatSessionCtrl.endAllSessionsForOrganization(client, orgId, userId);

        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'DELETE',
            metadata: { method: 'OTP_VERIFIED' }
        });

        await client.query("COMMIT");

        // Broadcast real-time socket event `org_deleted` and `org_status_changed`
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            socketService.notifyOrg(orgId, 'org_deleted', { orgId, deletedBy: userId });
            const membersRes = await pool.query(`SELECT user_id FROM organization_members WHERE org_id = $1`, [orgId]);
            for (const m of membersRes.rows) {
                socketService.notifyUser(m.user_id, 'org_status_changed', { orgId, status: 'deleted', action: 'deleted' });
            }
        } catch (sErr) {
            console.error("[DeleteOrg] Socket notification warning:", sErr);
        }


        res.json({
            success: true,
            message: "Organization scheduled for deletion",
            deletionDate: deletionExecuteAt
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Verify OTP and delete org error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
};

exports.restoreOrganization = async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ message: "Restoration token is required" });
    }

    const crypto = require("crypto");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const tokenRes = await client.query(
            `SELECT id, org_id, expires_at, used_at FROM organization_restoration_tokens WHERE token_hash = $1`,
            [tokenHash]
        );

        if (tokenRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Invalid restoration link." });
        }

        const tokenRow = tokenRes.rows[0];

        if (tokenRow.used_at) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "This company has already been restored." });
        }

        if (new Date(tokenRow.expires_at) < new Date()) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "This restoration link has expired." });
        }

        // Restore organization and clear batch
        await client.query(
            `UPDATE organizations 
             SET is_deleted = FALSE, deleted_at = NULL, deletion_scheduled_at = NULL, deletion_execute_at = NULL, deletion_batch_id = NULL
             WHERE org_id = $1`,
            [tokenRow.org_id]
        );

        // Mark token as used
        await client.query(
            `UPDATE organization_restoration_tokens SET used_at = NOW() WHERE id = $1`,
            [tokenRow.id]
        );

        await client.query("COMMIT");
        return res.status(200).json({ message: "Organization has been restored successfully." });
    } catch (err) {
        if (client) await client.query("ROLLBACK");
        console.error("Restore organization error:", err);
        return res.status(500).json({ message: "Failed to restore organization." });
    } finally {
        if (client) client.release();
    }
};

exports.getUserOrganizations = async (req, res) => {
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT c.*, 
             json_build_object(
                'name', cr.name,
                'description', cr.description,
                'permissions', cr.permissions,
                'priority', cr.priority
             ) as viewer_role_data,
             cr.name as role -- Keep for backward compatibility if needed, or use cr.name
             FROM organizations c
             JOIN organization_members cm ON c.org_id = cm.org_id
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.user_id = $1 AND c.is_deleted = FALSE AND cm.status = 'ACTIVE'
             ORDER BY c.created_at DESC`,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get user organizations error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getOwnedOrganizations = async (req, res) => {
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT c.*, 
             json_build_object(
                'name', cr.name,
                'description', cr.description,
                'permissions', cr.permissions,
                'priority', cr.priority
             ) as viewer_role_data,
             cr.name as role,
             TRUE as is_owner
             FROM organizations c
             JOIN organization_members cm ON c.org_id = cm.org_id
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE c.created_by = $1 AND c.is_deleted = FALSE AND cm.user_id = $1 AND cm.status = 'ACTIVE'
             ORDER BY c.created_at DESC`,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get owned organizations error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getUserOrganizationsSettings = async (req, res) => {

    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const formatDateStr = (dateVal) => {
            if (!dateVal) return "";
            const dateObj = new Date(dateVal);
            if (isNaN(dateObj.getTime())) return "";
            return dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        };

        // 1. Owned Orgs (Created by user)
        // Includes active, deactivated, and scheduled_for_deletion orgs IF deletion_execute_at > NOW()
        // Hides orgs where 40-day recovery window has passed (deletion_execute_at <= NOW())
        const ownedRes = await client.query(
            `SELECT o.org_id AS id, o.name, o.industry AS type, o.logo_url AS "logoUrl",
                    o.created_at, o.entity_type, o.is_deleted, o.deletion_execute_at, o.is_deactivated
             FROM organizations o
             WHERE o.created_by = $1
               AND (o.is_deleted = FALSE OR (o.is_deleted = TRUE AND o.deletion_execute_at > NOW()))
             ORDER BY o.created_at DESC`,
            [userId]
        );

        const ownedOrgs = ownedRes.rows.map(o => {
            let pageStatus = "active";
            if (o.is_deleted && o.deletion_execute_at && new Date(o.deletion_execute_at) > new Date()) {
                pageStatus = "scheduled_for_deletion";
            } else if (o.is_deactivated) {
                pageStatus = "deactivated";
            }

            return {
                id: o.id,
                name: o.name,
                type: o.type || "Company",
                logoUrl: o.logoUrl || null,
                relation: "owned",
                createdOn: formatDateStr(o.created_at),
                organizationType: o.entity_type === 'INSTITUTION' ? 'Institution' : 'Company',
                pageStatus
            };
        });

        // 2. Associated Orgs (User is member but NOT owner/creator)
        const assocRes = await client.query(
            `SELECT o.org_id AS id, o.name, o.industry AS type, o.logo_url AS "logoUrl",
                    om.joined_at, r.name AS role
             FROM organizations o
             JOIN organization_members om ON o.org_id = om.org_id
             LEFT JOIN organization_roles r ON om.role_id = r.role_id
             WHERE om.user_id = $1 AND (o.created_by IS NULL OR o.created_by != $1)
               AND om.status = 'ACTIVE' AND o.is_deleted = FALSE
             ORDER BY om.joined_at DESC`,
            [userId]
        );

        const associatedOrgs = assocRes.rows.map(o => ({
            id: o.id,
            name: o.name,
            type: o.type || "Company",
            logoUrl: o.logoUrl || null,
            relation: "associated",
            joinedOn: formatDateStr(o.joined_at),
            role: o.role || "Member",
            pageStatus: "associated"
        }));

        res.json({
            owned: ownedOrgs,
            associated: associatedOrgs
        });
    } catch (err) {
        console.error("Get user organizations settings error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.sendRecoverOrgOTP = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            `SELECT name, email, created_by, is_deleted, deletion_execute_at FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }
        const org = orgRes.rows[0];

        if (org.created_by !== userId) {
            return res.status(403).json({ message: "Only the organization owner can recover this page" });
        }

        if (!org.is_deleted) {
            return res.status(400).json({ message: "Organization is not scheduled for deletion" });
        }

        if (org.deletion_execute_at && new Date(org.deletion_execute_at) <= new Date()) {
            return res.status(400).json({ message: "The 40-day recovery window for this organization has expired. Page cannot be recovered." });
        }

        const ownerRes = await client.query(
            "SELECT email FROM users WHERE user_id = $1",
            [org.created_by]
        );
        const ownerEmail = ownerRes.rows[0]?.email;
        const orgEmail = org.email;

        const recipientSet = new Set();
        if (orgEmail && orgEmail.trim()) recipientSet.add(orgEmail.toLowerCase().trim());
        if (ownerEmail && ownerEmail.trim()) recipientSet.add(ownerEmail.toLowerCase().trim());

        const recipients = Array.from(recipientSet);
        if (recipients.length === 0) {
            return res.status(400).json({ message: "No registered email address found for this organization owner" });
        }

        const primaryEmail = recipients[0];

        const existing = await client.query(
            `SELECT created_at, request_count FROM email_otps WHERE email = $1`,
            [primaryEmail]
        );

        if (existing.rowCount > 0) {
            const record = existing.rows[0];
            const diffSeconds = (new Date() - new Date(record.created_at)) / 1000;
            if (diffSeconds < 5) {
                return res.status(429).json({ message: "A verification code was just requested. Please wait a few seconds." });
            }
            if (diffSeconds < 60 && record.request_count >= 3) {
                return res.status(429).json({ message: "Too many OTP requests. Please wait a minute before trying again." });
            }
        }

        const { generateSecureOTP } = require("../auth/otp.service");
        const bcrypt = require("bcrypt");
        const otp = generateSecureOTP();
        const otpHash = await bcrypt.hash(otp, 10);
        const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES) || 5;
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000);

        await client.query(
            `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count)
             VALUES ($1, $2, $3, 0, NOW(), 1)
             ON CONFLICT (email)
             DO UPDATE SET
                 otp_hash = EXCLUDED.otp_hash,
                 expires_at = EXCLUDED.expires_at,
                 attempts = 0,
                 created_at = NOW(),
                 request_count = email_otps.request_count + 1`,
            [primaryEmail, otpHash, expiresAt]
        );

        if (recipients.length > 1) {
            await client.query(
                `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count)
                 VALUES ($1, $2, $3, 0, NOW(), 1)
                 ON CONFLICT (email)
                 DO UPDATE SET
                     otp_hash = EXCLUDED.otp_hash,
                     expires_at = EXCLUDED.expires_at,
                     attempts = 0,
                     created_at = NOW(),
                     request_count = email_otps.request_count + 1`,
                [recipients[1], otpHash, expiresAt]
            );
        }

        const emailService = require("../../core/services/email.service");
        await emailService.sendOrgRecoverOTPEmail(recipients, otp, org.name);

        const maskedDisplay = recipients.map(maskEmail).join(", ");
        res.json({
            success: true,
            message: "Verification code sent to owner email",
            email_masked: maskedDisplay,
            expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
            cooldown_seconds: 30
        });
    } catch (err) {
        console.error("Send recover org OTP error:", err);
        res.status(500).json({ message: err.message || "Failed to send verification code" });
    } finally {
        client.release();
    }
};

exports.verifyOTPAndRecoverOrganization = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { otp } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orgRes = await client.query(
            `SELECT name, email, created_by, is_deleted, deletion_execute_at FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Organization not found" });
        }
        const org = orgRes.rows[0];

        if (org.created_by !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the organization owner can recover this page" });
        }

        if (!org.is_deleted) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Organization is not scheduled for deletion" });
        }

        if (org.deletion_execute_at && new Date(org.deletion_execute_at) <= new Date()) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "The 40-day recovery window for this organization has expired. Page cannot be recovered." });
        }

        if (otp) {
            if (String(otp).trim().length !== 6) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "6-digit verification code is required" });
            }

            const ownerRes = await client.query(
                "SELECT email FROM users WHERE user_id = $1",
                [org.created_by]
            );
            const ownerEmail = ownerRes.rows[0]?.email;
            const orgEmail = org.email;

            const recipientSet = new Set();
            if (orgEmail && orgEmail.trim()) recipientSet.add(orgEmail.toLowerCase().trim());
            if (ownerEmail && ownerEmail.trim()) recipientSet.add(ownerEmail.toLowerCase().trim());

            const recipients = Array.from(recipientSet);
            if (recipients.length === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "No registered email address found for this organization owner" });
            }

            const { verifyOTP } = require("../auth/otp.service");
            let otpResult = await verifyOTP(recipients[0], otp, true);
            if (otpResult.error && otpResult.error.message.includes("No active OTP found") && recipients.length > 1) {
                otpResult = await verifyOTP(recipients[1], otp, true);
            }

            if (otpResult.error) {
                await client.query("ROLLBACK");
                return res.status(otpResult.error.status || 400).json({ message: otpResult.error.message });
            }
        }

        // Restore organization and clear deletion timestamps
        await client.query(
            `UPDATE organizations 
             SET is_deleted = FALSE, deleted_at = NULL, deletion_scheduled_at = NULL, deletion_execute_at = NULL, deletion_batch_id = NULL, updated_at = NOW()
             WHERE org_id = $1`,
            [orgId]
        );

        await logAudit(client, {
            entityId: orgId,
            entityType: 'ORGANIZATION',
            actorId: userId,
            action: 'ORGANIZATION_RECOVERED',
            metadata: {}
        });

        await client.query("COMMIT");

        // Broadcast real-time socket event to all organization members
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            const membersRes = await pool.query(`SELECT user_id FROM organization_members WHERE org_id = $1`, [orgId]);
            for (const m of membersRes.rows) {
                socketService.notifyUser(m.user_id, 'org_status_changed', { orgId, status: 'active', action: 'recovered' });
            }
        } catch (sErr) {
            console.error("[RecoverOrg] Socket notification error:", sErr);
        }

        res.json({
            success: true,
            message: "Organization recovered successfully",
            data: { id: orgId, pageStatus: "active" }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Recover organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};




exports.searchOrganizations = async (req, res) => {
    const { q, entity_type } = req.query;
    if (!q || q.trim().length === 0) {
        return res.json([]);
    }
    const rawSearchTerm = q.trim();
    const searchTerm = `%${rawSearchTerm}%`;
    const limit = parseInt(req.query.limit) || 10;

    const client = await pool.connect();
    try {
        let queryStr = `
             SELECT org_id, name, slug, logo_url, entity_type, location, industry, headline,
                    similarity(name, $1) AS score
             FROM organizations 
             WHERE (name ILIKE $2 OR slug ILIKE $2) AND is_deleted = FALSE
        `;
        const queryParams = [rawSearchTerm, searchTerm];

        if (entity_type) {
            queryParams.push(entity_type);
            queryStr += ` AND entity_type = $${queryParams.length}`;
        }

        queryStr += ` ORDER BY score DESC, name ASC LIMIT $${queryParams.length + 1}`;
        queryParams.push(limit);

        const result = await client.query(queryStr, queryParams);
        res.json(result.rows);
    } catch (err) {
        console.error("Search organizations error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ─── COMPANY ONBOARDING WIZARD METHODS ────────────────────────────────────────────────────────

const generateUniqueSlug = async (client, name, orgId) => {
    let baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!baseSlug) baseSlug = "org";
    let slug = baseSlug;
    let count = 1;
    while (true) {
        const query = orgId 
            ? `SELECT 1 FROM organizations WHERE slug = $1 AND org_id != $2`
            : `SELECT 1 FROM organizations WHERE slug = $1`;
        const params = orgId ? [slug, orgId] : [slug];
        const check = await client.query(query, params);
        if (check.rowCount === 0) {
            break;
        }
        slug = `${baseSlug}-${count}`;
        count++;
    }
    return slug;
};

exports.getCountriesList = async (req, res) => {
    res.json({
        success: true,
        countries: ["India", "UAE", "Japan"]
    });
};

exports.createDraftType = async (req, res) => {
    const userId = req.user.sub;
    const { type } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existingRes = await client.query(
            `SELECT org_id, entity_type, onboarding_step FROM organizations 
             WHERE created_by = $1 AND onboarding_completed = FALSE AND is_deleted = FALSE 
             LIMIT 1`,
            [userId]
        );

        if (existingRes.rowCount > 0) {
            const org = existingRes.rows[0];
            if (org.entity_type !== type) {
                await client.query(
                    `UPDATE organizations SET entity_type = $1, updated_at = NOW() WHERE org_id = $2`,
                    [type, org.org_id]
                );
            }
            await client.query("COMMIT");
            return res.status(200).json({
                success: true,
                org_id: org.org_id,
                entity_type: type,
                onboarding_step: org.onboarding_step || 'IDENTITY'
            });
        }

        const crypto = require("crypto");
        const draftId = crypto.randomUUID();
        const tempName = "Draft Organization";
        const tempSlug = `draft-${draftId.slice(0, 8)}`;

        const insertText = `
            INSERT INTO organizations (org_id, name, slug, entity_type, created_by, onboarding_step, onboarding_completed)
            VALUES ($1, $2, $3, $4, $5, 'IDENTITY', FALSE)
            RETURNING *
        `;
        const result = await client.query(insertText, [draftId, tempName, tempSlug, type, userId]);
        
        await logAudit(client, {
            entityId: draftId,
            actorId: userId,
            action: 'CREATE_DRAFT',
            metadata: { type }
        });

        await client.query("COMMIT");
        res.status(201).json({
            success: true,
            org_id: result.rows[0].org_id,
            entity_type: type,
            onboarding_step: 'IDENTITY'
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Create draft type error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getOnboardingProgress = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            `SELECT * FROM organizations WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Draft organization not found or access denied" });
        }

        const org = orgRes.rows[0];

        const docRes = await client.query(
            `SELECT * FROM organization_documents WHERE org_id = $1`,
            [orgId]
        );

        res.json({
            success: true,
            organization: org,
            documents: docRes.rows
        });
    } catch (err) {
        console.error("Get onboarding progress error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getProfilePreview = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            `SELECT name, logo_url, headline, email, phone, website, size, country, city, description, 
                    email_verified, phone_verified, verification_status
             FROM organizations 
             WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }

        res.json({
            success: true,
            preview: orgRes.rows[0]
        });
    } catch (err) {
        console.error("Get profile preview error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.saveDraftIdentity = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { name, established_year, industry, institution_type, campus_location, remove_logo } = req.body;

    let logoUrl = null;
    if (req.file) {
        logoUrl = req.file.path.replace(/\\/g, "/");
    } else if (remove_logo === 'true') {
        logoUrl = 'REMOVE';
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orgCheck = await client.query(
            `SELECT entity_type, logo_url FROM organizations WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgCheck.rowCount === 0) {
            throw new AppError("Draft organization not found or access denied", 404);
        }

        const org = orgCheck.rows[0];
        const slug = await generateUniqueSlug(client, name, orgId);
        const establishedYearInt = established_year ? parseInt(established_year, 10) : null;

        const updateText = `
            UPDATE organizations
            SET name = $1,
                slug = $2,
                established_year = $3,
                logo_url = CASE WHEN $4::text = 'REMOVE' THEN NULL ELSE COALESCE($4, logo_url) END,
                industry = $5,
                institution_type = $6,
                campus_location = $7,
                onboarding_step = 'PRESENCE',
                updated_at = NOW()
            WHERE org_id = $8
            RETURNING *
        `;

        const result = await client.query(updateText, [
            name,
            slug,
            establishedYearInt,
            logoUrl,
            org.entity_type === 'COMPANY' ? industry : null,
            org.entity_type === 'INSTITUTION' ? institution_type : null,
            org.entity_type === 'INSTITUTION' ? campus_location : null,
            orgId
        ]);

        await client.query("COMMIT");

        res.json({
            success: true,
            org_id: orgId,
            name: result.rows[0].name,
            slug: result.rows[0].slug,
            logo_url: result.rows[0].logo_url,
            onboarding_step: 'PRESENCE'
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Save draft identity error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.saveDraftPresence = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { email, phone, website, size, country, city, headline, description } = req.body;

    if (phone) {
        const p = phone.trim();
        if (p.startsWith('+91') && p.replace(/\D/g, '').length !== 12) {
            return res.status(400).json({ success: false, message: "India phone numbers must be exactly 10 digits." });
        }
        if (p.startsWith('+971') && p.replace(/\D/g, '').length !== 12) {
            return res.status(400).json({ success: false, message: "UAE phone numbers must be exactly 9 digits." });
        }
        if (p.startsWith('+81') && p.replace(/\D/g, '').length !== 12) {
            return res.status(400).json({ success: false, message: "Japan phone numbers must be exactly 10 digits." });
        }
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orgCheck = await client.query(
            `SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgCheck.rowCount === 0) {
            throw new AppError("Draft organization not found or access denied", 404);
        }

        const updateText = `
            UPDATE organizations
            SET email = $1,
                phone = $2,
                website = $3,
                size = $4,
                country = $5,
                city = $6,
                headline = $7,
                description = $8,
                onboarding_step = 'VERIFICATION',
                updated_at = NOW()
            WHERE org_id = $9
            RETURNING *
        `;

        await client.query(updateText, [
            email, phone, website || null, size, country, city, headline, description || null, orgId
        ]);

        await client.query("COMMIT");

        res.json({
            success: true,
            onboarding_step: 'VERIFICATION'
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Save draft presence error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.sendEmailOTP = async (req, res) => {
    const userId = req.user.sub;
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const crypto = require("crypto");
        const otp = crypto.randomInt(100000, 999999).toString();
        const bcrypt = require("bcrypt");
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + 10 * 60000);

        await client.query(
            `INSERT INTO organization_verifications (user_id, otp, expires_at, verification_type, target_value)
             VALUES ($1, $2, $3, 'EMAIL', $4)`,
            [userId, otpHash, expiresAt, normalizedEmail]
        );

        try {
            const emailService = require("../../core/services/email.service");
            await emailService.sendOTPEmail(normalizedEmail, otp);
        } catch (mailErr) {
            console.warn(`[EMAIL VERIFICATION MOCK] Resend failed, falling back to mock:`, mailErr.message);
            console.log(`[EMAIL VERIFICATION MOCK] OTP for ${normalizedEmail}: ${otp}`);
        }

        await client.query("COMMIT");
        res.json({ success: true, message: "Verification code sent to email." });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Send email OTP error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.confirmEmailOTP = async (req, res) => {
    const userId = req.user.sub;
    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const vRes = await client.query(
            `SELECT * FROM organization_verifications 
             WHERE user_id = $1 AND verification_type = 'EMAIL' AND target_value = $2 AND is_verified = FALSE
             ORDER BY created_at DESC LIMIT 1`,
            [userId, normalizedEmail]
        );

        if (vRes.rowCount === 0) {
            throw new AppError("No verification attempt found", 400);
        }

        const record = vRes.rows[0];

        if (new Date() > record.expires_at) {
            throw new AppError("Verification code expired", 400);
        }

        if (record.attempts >= 5) {
            throw new AppError("Max attempts exceeded. Please request a new code.", 400);
        }

        await client.query(
            `UPDATE organization_verifications SET attempts = attempts + 1 WHERE verification_id = $1`,
            [record.verification_id]
        );

        const bcrypt = require("bcrypt");
        const isValid = await bcrypt.compare(otp.toString(), record.otp);

        if (!isValid) {
            throw new AppError("Invalid verification code", 400);
        }

        await client.query(
            `UPDATE organization_verifications SET is_verified = TRUE WHERE verification_id = $1`,
            [record.verification_id]
        );

        await client.query("COMMIT");
        res.json({ success: true, verified: true });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Confirm email OTP error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.sendPhoneOTP = async (req, res) => {
    const userId = req.user.sub;
    const { phone } = req.body;
    const normalizedPhone = phone.trim();

    if (normalizedPhone.startsWith('+91') && normalizedPhone.replace(/\D/g, '').length !== 12) {
        return res.status(400).json({ success: false, message: "India phone numbers must be exactly 10 digits." });
    }
    if (normalizedPhone.startsWith('+971') && normalizedPhone.replace(/\D/g, '').length !== 12) {
        return res.status(400).json({ success: false, message: "UAE phone numbers must be exactly 9 digits." });
    }
    if (normalizedPhone.startsWith('+81') && normalizedPhone.replace(/\D/g, '').length !== 12) {
        return res.status(400).json({ success: false, message: "Japan phone numbers must be exactly 10 digits." });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const smsService = require("../../core/services/sms.service");
        const formattedPhone = smsService.normalizePhone(normalizedPhone);

        const crypto = require("crypto");
        const otp = crypto.randomInt(100000, 999999).toString();
        const bcrypt = require("bcrypt");
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + 10 * 60000);

        await client.query(
            `INSERT INTO organization_verifications (user_id, otp, expires_at, verification_type, target_value)
             VALUES ($1, $2, $3, 'PHONE', $4)`,
            [userId, otpHash, expiresAt, formattedPhone]
        );

        await smsService.sendSMSOTP(formattedPhone, otp);

        await client.query("COMMIT");
        res.json({ success: true, message: "Verification code sent via SMS." });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Send phone OTP error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.confirmPhoneOTP = async (req, res) => {
    const userId = req.user.sub;
    const { phone, otp } = req.body;
    const normalizedPhone = phone.trim();

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const smsService = require("../../core/services/sms.service");
        const formattedPhone = smsService.normalizePhone(normalizedPhone);

        const vRes = await client.query(
            `SELECT * FROM organization_verifications 
             WHERE user_id = $1 AND verification_type = 'PHONE' AND target_value = $2 AND is_verified = FALSE
             ORDER BY created_at DESC LIMIT 1`,
            [userId, formattedPhone]
        );

        if (vRes.rowCount === 0) {
            throw new AppError("No verification attempt found", 400);
        }

        const record = vRes.rows[0];

        if (new Date() > record.expires_at) {
            throw new AppError("Verification code expired", 400);
        }

        if (record.attempts >= 5) {
            throw new AppError("Max attempts exceeded. Please request a new code.", 400);
        }

        await client.query(
            `UPDATE organization_verifications SET attempts = attempts + 1 WHERE verification_id = $1`,
            [record.verification_id]
        );

        const isValid = await smsService.verifySMSOTP(formattedPhone, otp, record.otp);

        const bcrypt = require("bcrypt");
        const isBcryptValid = await bcrypt.compare(otp.toString(), record.otp);

        if (!isValid && !isBcryptValid) {
            throw new AppError("Invalid verification code", 400);
        }

        await client.query(
            `UPDATE organization_verifications SET is_verified = TRUE WHERE verification_id = $1`,
            [record.verification_id]
        );

        await client.query("COMMIT");
        res.json({ success: true, verified: true });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Confirm phone OTP error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.saveDraftVerification = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { country_of_operation } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orgCheck = await client.query(
            `SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgCheck.rowCount === 0) {
            throw new AppError("Draft organization not found or access denied", 404);
        }

        await client.query(
            `UPDATE organizations 
             SET country = COALESCE($1, country), 
                 verification_status = 'DOCUMENT_PENDING',
                 updated_at = NOW() 
             WHERE org_id = $2`,
            [country_of_operation || null, orgId]
        );

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const docUrl = file.path.replace(/\\/g, "/");
                const docName = file.originalname || "document";
                const docType = file.mimetype || "application/pdf";

                await client.query(
                    `INSERT INTO organization_documents (org_id, document_url, document_name, document_type)
                     VALUES ($1, $2, $3, $4)`,
                    [orgId, docUrl, docName, docType]
                );
            }
        }

        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'DOCUMENTS_SUBMITTED',
            metadata: { count: req.files ? req.files.length : 0 }
        });

        await client.query("COMMIT");
        res.json({
            success: true,
            onboarding_step: 'VERIFICATION'
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Save draft verification error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.completeOnboardingFlow = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orgRes = await client.query(
            `SELECT * FROM organizations WHERE org_id = $1 AND created_by = $2 AND is_deleted = FALSE`,
            [orgId, userId]
        );

        if (orgRes.rowCount === 0) {
            throw new AppError("Draft organization not found or access denied", 404);
        }

        const org = orgRes.rows[0];

        if (org.onboarding_completed) {
            return res.status(400).json({ success: false, message: "Onboarding already completed" });
        }

        if (!org.name || org.name === "Draft Organization") {
            throw new AppError("Organization name must be set before completing onboarding", 400);
        }
        if (!org.email_verified) {
            throw new AppError("Organization email must be verified before completing onboarding", 400);
        }
        if (!org.phone_verified) {
            throw new AppError("Organization phone number must be verified before completing onboarding", 400);
        }

        await client.query(
            `UPDATE organizations 
             SET onboarding_completed = TRUE,
                 onboarding_step = NULL,
                 verification_status = 'DOMAIN_VERIFIED',
                 updated_at = NOW()
             WHERE org_id = $1`,
            [orgId]
        );

        let roles;
        let ownerRoleName;

        ownerRoleName = 'Admin';
        roles = [
            { name: 'Admin', color: '#FFD700', permissions: ["*"], priority: 100, is_system: true }
        ];

        let ownerRoleId;

        for (const r of roles) {
            const roleCheck = await client.query(
                `SELECT role_id FROM organization_roles WHERE org_id = $1 AND name = $2`,
                [orgId, r.name]
            );

            if (roleCheck.rowCount > 0) {
                if (r.name === ownerRoleName) ownerRoleId = roleCheck.rows[0].role_id;
            } else {
                const rRes = await client.query(
                    `INSERT INTO organization_roles (org_id, name, color, permissions, priority, is_system_role)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING role_id`,
                    [orgId, r.name, r.color, JSON.stringify(r.permissions), r.priority, r.is_system]
                );
                if (r.name === ownerRoleName) ownerRoleId = rRes.rows[0].role_id;
            }
        }

        const memberCheck = await client.query(
            `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId]
        );

        if (memberCheck.rowCount === 0) {
            await client.query(
                `INSERT INTO organization_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
                [orgId, userId, ownerRoleId]
            );
        }

        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'ONBOARDING_COMPLETED',
            metadata: { name: org.name, slug: org.slug }
        });

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Onboarding completed successfully!",
            slug: org.slug
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Complete onboarding flow error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.publishNewOrganization = async (req, res) => {
    const userId = req.user.sub;
    const {
        name,
        established_year,
        industry,
        email,
        phone,
        website,
        size,
        country,
        city,
        headline,
        description,
        type,
        country_of_operation
    } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        if (email) {
            const normalizedEmail = email.toLowerCase().trim();
            const emailCheck = await client.query(
                `SELECT 1 FROM organization_verifications 
                 WHERE user_id = $1 AND target_value = $2 AND verification_type = 'EMAIL' AND is_verified = TRUE`,
                [userId, normalizedEmail]
            );
            if (emailCheck.rowCount === 0) {
                throw new AppError("Email has not been verified.", 400);
            }
        }

        if (phone) {
            const smsService = require("../../core/services/sms.service");
            const normalizedPhone = smsService.normalizePhone(phone.trim());
            const phoneCheck = await client.query(
                `SELECT 1 FROM organization_verifications 
                 WHERE user_id = $1 AND target_value = $2 AND verification_type = 'PHONE' AND is_verified = TRUE`,
                [userId, normalizedPhone]
            );
            if (phoneCheck.rowCount === 0) {
                throw new AppError("Phone number has not been verified.", 400);
            }
        }

        let logoUrl = null;
        if (req.files && req.files.logo && req.files.logo.length > 0) {
            logoUrl = req.files.logo[0].path.replace(/\\/g, "/");
        }

        const slug = await generateUniqueSlug(client, name);
        const establishedYearInt = established_year ? parseInt(established_year, 10) : null;
        const isInstitution = type === 'INSTITUTION';

        // TODO(admin-verification): institutions are auto-marked VERIFIED because the
        // admin document/domain review flow isn't wired up yet. Once it exists, institutions
        // should start at UNVERIFIED and go through that flow like the verification_status
        // check in content.controller.js already expects.
        const initialVerificationStatus = isInstitution ? 'VERIFIED' : 'UNVERIFIED';

        const insertQuery = `
            INSERT INTO organizations (
                name, slug, entity_type, established_year, industry, institution_type,
                logo_url, email, phone, website, size, country, city,
                headline, description, created_by, onboarding_step, onboarding_completed, email_verified, phone_verified,
                verification_status
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'COMPLETED', TRUE, TRUE, TRUE, $17
            ) RETURNING *
        `;

        const orgRes = await client.query(insertQuery, [
            name,
            slug,
            type || 'COMPANY',
            establishedYearInt,
            isInstitution ? null : (industry || null),
            isInstitution ? (industry || null) : null,
            logoUrl,
            email ? email.toLowerCase().trim() : null,
            phone ? phone.trim() : null,
            website || null,
            size || null,
            country || null,
            city || null,
            headline || null,
            description || null,
            userId,
            initialVerificationStatus
        ]);

        const newOrg = orgRes.rows[0];
        const orgId = newOrg.org_id;

        // Determine roles based on entity type
        const entityType = newOrg.entity_type;
        let ownerRoleName, roles;

        ownerRoleName = 'Admin';
        roles = [
            { name: 'Admin', color: '#FFD700', permissions: ['*'], priority: 100 }
        ];

        let ownerRoleId;
        for (const r of roles) {
            const rRes = await client.query(
                `INSERT INTO organization_roles (org_id, name, color, permissions, priority, is_system_role)
                 VALUES ($1, $2, $3, $4, $5, TRUE)
                 RETURNING role_id`,
                [orgId, r.name, r.color, JSON.stringify(r.permissions), r.priority]
            );
            if (r.name === ownerRoleName) ownerRoleId = rRes.rows[0].role_id;
        }

        // Add creator as owner/admin member with the correct role
        await client.query(
            `INSERT INTO organization_members (org_id, user_id, role_id, status, is_primary_display, is_core_team)
             VALUES ($1, $2, $3, 'ACTIVE', FALSE, TRUE)`,
            [orgId, userId, ownerRoleId]
        );

        if (req.files && req.files.documents && req.files.documents.length > 0) {
            for (let doc of req.files.documents) {
                const docUrl = doc.path.replace(/\\/g, "/");
                await client.query(
                    `INSERT INTO organization_documents (org_id, document_url, document_name, document_type)
                     VALUES ($1, $2, $3, $4)`,
                    [orgId, docUrl, doc.originalname, doc.mimetype]
                );
            }
        }

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "Organization created successfully",
            slug: slug,
            org_id: orgId
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Publish new organization error:", err);
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

