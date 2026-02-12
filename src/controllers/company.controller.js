const pool = require("../db/pool");

// Helper for Audit Logging
const logAudit = async (client, { entityId, actorId, action, metadata = {} }) => {
    const query = `
    INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `;
    await client.query(query, ['COMPANY', entityId, actorId, action, metadata]);
};

// Helper: Check if user is OWNER or ADMIN
const checkRole = async (client, companyId, userId, allowedRoles = ['OWNER', 'ADMIN']) => {
    const res = await client.query(
        `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2`,
        [companyId, userId]
    );
    if (res.rowCount === 0) return null;
    const role = res.rows[0].role;
    return allowedRoles.includes(role) ? role : null;
};

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
            throw new Error("Rate limit exceeded: You can only create 3 companies per day.");
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
        await client.query(
            `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
            [company.company_id, userId]
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
        if (err.message.includes("Slug already taken")) {
            return res.status(409).json({ message: "Slug is already taken" });
        }
        if (err.message.includes("Rate limit")) {
            return res.status(429).json({ message: err.message });
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
        ${userId ? `(SELECT role FROM company_members cm WHERE cm.company_id = c.company_id AND cm.user_id = $2) as viewer_role` : 'NULL as viewer_role'}
       FROM companies c
       WHERE c.slug = $1 AND c.is_deleted = FALSE`,
            userId ? [slug, userId] : [slug]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Company not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Get company error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateCompany = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const { name, slogan, industry, size, website, location, description, logo_url, cover_url } = req.body;

    // Basic validation
    if (!name || name.trim().length < 2) {
        return res.status(400).json({ message: "Company name must be at least 2 characters" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC Check (ADMIN or OWNER)
        const userRole = await checkRole(client, companyId, userId, ['OWNER', 'ADMIN']);
        if (!userRole) throw new Error("Forbidden: Only Admins can update company details");

        // 2. Update
        // Note: slug update is restricted for now to avoid breaking links/indices easily.
        // Can be added later with more checks.
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
                updated_at = NOW()
            WHERE company_id = $10
            RETURNING *
        `;

        const result = await client.query(updateQuery, [
            name, slogan, industry, size, website, location, description, logo_url, cover_url, companyId
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
    const { email, role } = req.body;

    if (!email || !role || !['ADMIN', 'EDITOR'].includes(role)) {
        return res.status(400).json({ message: "Valid email and role (ADMIN or EDITOR) are required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC Check
        const userRole = await checkRole(client, companyId, userId, ['OWNER', 'ADMIN']);
        if (!userRole) {
            throw new Error("Forbidden: You allow to invite members");
        }

        // 2. Rate Limit (10 invites per day per company)
        const rateLimitRes = await client.query(
            `SELECT COUNT(*) FROM company_invites 
             WHERE company_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
            [companyId]
        );
        if (parseInt(rateLimitRes.rows[0].count) >= 10) {
            throw new Error("Rate limit exceeded: Max 10 invites per day per company.");
        }

        // 3. Idempotent Upsert Helper
        // Generate Token
        const token = require('crypto').randomBytes(20).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        // Insert or Update existing invite
        await client.query(
            `INSERT INTO company_invites (company_id, inviter_id, email, role, token, expires_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
             ON CONFLICT (company_id, email) 
             DO UPDATE SET 
                role = EXCLUDED.role,
                token = EXCLUDED.token,
                expires_at = EXCLUDED.expires_at,
                inviter_id = EXCLUDED.inviter_id,
                status = 'PENDING',
                updated_at = NOW()`,
            [companyId, userId, email, role, token, expiresAt]
        );

        // 4. Audit Log
        await logAudit(client, {
            entityId: companyId,
            actorId: userId,
            action: 'INVITE_MEMBER',
            metadata: { email, role }
        });

        await client.query("COMMIT");

        // TODO: Send Email (Mocked)
        console.log(`[MOCK EMAIL] Invite sent to ${email} for company ${companyId} with token ${token}`);

        res.status(200).json({ message: "Invitation sent successfully", token }); // Return token for manual testing

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Invite member error:", err);
        if (err.message.startsWith("Forbidden") || err.message.startsWith("Rate limit")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
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
        const userRole = await checkRole(client, companyId, userId, ['OWNER']);
        if (!userRole) throw new Error("Forbidden: Only OWNER can verify domain");

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
            console.warn(`[Invite] Email mismatch warning: Invite ${invite.email} accepted by ${userRes.rows[0].email}`);
            // allow for now, or block? usually strict match required.
            // throw new Error("This invitation was sent to a different email address."); 
        }

        // 2b. Check if User is ALREADY a member
        const memberCheck = await client.query(
            `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [invite.company_id, userId]
        );

        if (memberCheck.rowCount > 0) {
            const existingRole = memberCheck.rows[0].role;
            if (existingRole === 'OWNER') {
                throw new Error("You are the OWNER of this company. You cannot accept an invitation.");
            } else {
                throw new Error(`You are already a member as ${existingRole}.`);
            }
        }

        // 3. Add to Members
        await client.query(
            `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [invite.company_id, userId, invite.role]
        );

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
    const { newOwnerId } = req.body;

    if (!newOwnerId) return res.status(400).json({ message: "New Owner ID required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC (OWNER ONLY)
        const userRole = await checkRole(client, companyId, userId, ['OWNER']);
        if (!userRole) throw new Error("Forbidden: Only OWNER can transfer ownership");

        // 2. Transaction
        // Demote current OWNER to ADMIN
        await client.query(
            `UPDATE company_members SET role = 'ADMIN' WHERE company_id = $1 AND user_id = $2`,
            [companyId, userId]
        );

        // Promote new user to OWNER (Upsert if they are already member, or insert)
        // Actually, they must be a member? Or we can add them?
        // Let's assume they might be a member already.
        const memberCheck = await client.query(
            `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, newOwnerId]
        );

        if (memberCheck.rowCount > 0) {
            await client.query(
                `UPDATE company_members SET role = 'OWNER' WHERE company_id = $1 AND user_id = $2`,
                [companyId, newOwnerId]
            );
        } else {
            // If strictly must be member first, throw error. For flexibility, let's add them.
            await client.query(
                `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
                [companyId, newOwnerId]
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

        // 1. RBAC (OWNER ONLY)
        const userRole = await checkRole(client, companyId, userId, ['OWNER']);
        if (!userRole) throw new Error("Forbidden: Only OWNER can delete company");

        // 2. Soft Delete
        await client.query(
            `UPDATE companies SET is_deleted = TRUE, deleted_at = NOW() WHERE company_id = $1`,
            [companyId]
        );

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
    const { page = 1, limit = 10 } = req.query; // Pagination params
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
        // RBAC: Allow OWNER and ADMIN to view full member list (with emails)
        // Editors might need to see list too? Let's allow OWNER/ADMIN for management for now.
        const userRole = await checkRole(client, companyId, userId, ['OWNER', 'ADMIN', 'EDITOR']);
        if (!userRole) {
            return res.status(403).json({ message: "Forbidden: You must be a member to view members" });
        }

        // Get Total Count
        const countRes = await client.query(
            `SELECT COUNT(*) FROM company_members WHERE company_id = $1`,
            [companyId]
        );
        const total = parseInt(countRes.rows[0].count);

        const result = await client.query(
            `SELECT u.user_id, u.full_name, u.email, u.avatar_url, cm.role, cm.joined_at
             FROM company_members cm
             JOIN users u ON cm.user_id = u.user_id
             WHERE cm.company_id = $1
             ORDER BY cm.role='OWNER' DESC, cm.role='ADMIN' DESC, cm.joined_at ASC
             LIMIT $2 OFFSET $3`,
            [companyId, limit, offset]
        );

        const members = result.rows.map(row => {
            // Hide email if requester is only an EDITOR
            if (userRole === 'EDITOR' && row.user_id !== userId) {
                const [username, domain] = row.email.split('@');
                const maskedUsername = username.charAt(0) + '****' + username.charAt(username.length - 1);
                return { ...row, email: `${maskedUsername}@${domain}` };
            }
            return row;
        });

        res.json({
            data: members,
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

        // 1. Check requester role
        const requesterRole = await checkRole(client, companyId, userId, ['OWNER', 'ADMIN']);
        if (!requesterRole) throw new Error("Forbidden: You cannot remove members");

        // 2. Check target member role
        const targetRes = await client.query(
            `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, memberId]
        );
        if (targetRes.rowCount === 0) throw new Error("Member not found");
        const targetRole = targetRes.rows[0].role;

        // 3. Enforce Hierarchy
        // OWNER cannot be removed (must transfer ownership)
        if (targetRole === 'OWNER') throw new Error("Cannot remove OWNER. Transfer ownership first.");

        // ADMIN cannot remove other ADMINs? usually yes, or restricted. 
        // Let's say ADMIN can remove EDITOR. OWNER can remove ADMIN/EDITOR.
        if (requesterRole === 'ADMIN' && targetRole === 'ADMIN') {
            throw new Error("Admins cannot remove other Admins");
        }

        // 4. Remove
        await client.query(
            `DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`,
            [companyId, memberId]
        );

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
            `SELECT c.*, cm.role
             FROM companies c
             JOIN company_members cm ON c.company_id = cm.company_id
             WHERE cm.user_id = $1 AND c.is_deleted = FALSE
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
