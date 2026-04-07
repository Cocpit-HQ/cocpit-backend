const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { checkOrgPermission } = require("../../core/utils/rbac");
const { wouldCreateCycle } = require("./organization.hierarchy.controller");

// Helper for Audit Logging
const logAudit = async (client, { entityId, actorId, action, metadata = {} }) => {
    const query = `
    INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `;
    await client.query(query, ['ORGANIZATION', entityId, actorId, action, metadata]);
};

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
            `SELECT COUNT(*) FROM organization_members WHERE user_id = $1 AND role = 'OWNER'`,
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

        // 5. Add Creator as Primary Admin/Owner role
        let roles;
        let ownerRoleName;

        if (entityType === 'INSTITUTION') {
            ownerRoleName = 'Admin';
            roles = [
                { name: 'Admin', color: '#FFD700', permissions: ["*"], priority: 100, is_system: true },
                { name: 'Faculty', color: '#FF0000', permissions: ["SWITCH_TO_COMPANY", "CREATE_ACADEMIC_CONTENT", "MODERATE_STUDENTS", "VIEW_MEMBERS"], priority: 80, is_system: true },
                { name: 'Student Moderator', color: '#00FF00', permissions: ["SWITCH_TO_COMPANY", "CREATE_GENERAL_CONTENT", "MODERATE_GENERAL", "VIEW_MEMBERS"], priority: 60, is_system: true },
                { name: 'Student', color: '#0000FF', permissions: ["SWITCH_TO_COMPANY", "CREATE_GENERAL_CONTENT", "VIEW_MEMBERS"], priority: 10, is_system: true }
            ];
        } else {
            ownerRoleName = 'Owner';
            roles = [
                { name: 'Owner', color: '#FFD700', permissions: ["*"], priority: 100, is_system: true },
                { name: 'Admin', color: '#FF0000', permissions: ["SWITCH_TO_COMPANY", "MANAGE_COMPANY", "MANAGE_COMPANY_DETAILS", "MANAGE_SETTINGS", "MANAGE_ROLES", "MANAGE_MEMBERS", "INVITE_MEMBERS", "REMOVE_MEMBERS", "VIEW_MEMBERS", "POST_JOBS", "VIEW_JOBS", "MANAGE_JOBS", "VIEW_APPLICANTS", "MANAGE_APPLICANTS", "CREATE_CONTENT", "MANAGE_COMMENTS", "VIEW_ANALYTICS"], priority: 90, is_system: true },
                { name: 'Editor', color: '#00FF00', permissions: ["SWITCH_TO_COMPANY", "CREATE_CONTENT", "VIEW_ANALYTICS", "VIEW_MEMBERS", "MANAGE_COMPANY_DETAILS"], priority: 60, is_system: true },
                { name: 'Recruiter', color: '#0000FF', permissions: ["SWITCH_TO_COMPANY", "POST_JOBS", "VIEW_JOBS", "VIEW_APPLICANTS", "MANAGE_APPLICANTS", "VIEW_MEMBERS"], priority: 50, is_system: true },
                { name: 'Analyst', color: '#800080', permissions: ["SWITCH_TO_COMPANY", "VIEW_ANALYTICS", "VIEW_MEMBERS"], priority: 40, is_system: true }
            ];
        }

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
            `INSERT INTO organization_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
            [company.org_id, userId, ownerRoleId]
        );

        // 6. Audit Log
        await logAudit(client, {
            entityId: company.org_id,
            actorId: userId,
            action: 'CREATE',
            metadata: { name, slug }
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

        // Audit Log for Analytics (Legacy / Additional logging)
        if (userId && company.org_id) {
            (async () => {
                const auditClient = await pool.connect();
                try {
                    // Refinement: Debounce VIEW logs (1 hour cooldown)
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
                        if (timeDiff < 60 * 60 * 1000) { // 1 hour
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

        // 2a. Nullify children's parent reference before soft-deleting
        // Keeps children as independent top-level orgs rather than orphaning them.
        await client.query(
            `UPDATE organizations SET parent_org_id = NULL, updated_at = NOW() WHERE parent_org_id = $1`,
            [orgId]
        );

        // 2b. Soft Delete
        await client.query(
            `UPDATE organizations SET is_deleted = TRUE, deleted_at = NOW() WHERE org_id = $1`,
            [orgId]
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

        await client.query("COMMIT");
        res.json({ message: "Organization deleted successfully" });

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

exports.getUserOrganizations = async (req, res) => {
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

exports.searchOrganizations = async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
        return res.json([]);
    }
    const searchTerm = `%${q.trim()}%`;
    const limit = parseInt(req.query.limit) || 10;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT org_id, name, slug, logo_url, entity_type, location, industry, headline 
             FROM organizations 
             WHERE (name ILIKE $1 OR slug ILIKE $1) AND is_deleted = FALSE
             ORDER BY name ASC 
             LIMIT $2`,
            [searchTerm, limit]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Search organizations error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};
