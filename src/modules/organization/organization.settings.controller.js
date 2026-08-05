const pool = require("../../core/db/pool");
const { checkOrgPermission } = require("../../core/utils/rbac");

const { logAudit } = require("../../core/infrastructure/audit.service");

// --- Tech Stack ---

exports.getTechStack = async (req, res) => {
    const { slug } = req.params;
    try {
        const result = await pool.query(
            `SELECT t.* FROM organization_tech_stack t
             JOIN organizations c ON t.org_id = c.org_id
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
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { name, category } = req.body;

    if (!name) return res.status(400).json({ message: "Technology name is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit organization profile");

        const result = await client.query(
            `INSERT INTO organization_tech_stack (org_id, name, category)
             VALUES ($1, $2, $3)
             ON CONFLICT (org_id, name) DO NOTHING
             RETURNING *`,
            [companyId, name, category || 'Other']
        );

        // If row already exists, just return success or fetch it
        if (result.rowCount === 0) {
            const existing = await client.query(
                `SELECT * FROM organization_tech_stack WHERE org_id = $1 AND name = $2`,
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
    const { orgId: companyId, stackId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit organization profile");

        await client.query(
            `DELETE FROM organization_tech_stack WHERE org_id = $1 AND stack_id = $2`,
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
            `SELECT g.* FROM organization_gallery g
             JOIN organizations c ON g.org_id = c.org_id
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
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { url, type, caption } = req.body;

    if (!url) return res.status(400).json({ message: "URL is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit organization profile");

        const result = await client.query(
            `INSERT INTO organization_gallery (org_id, url, type, caption)
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
    const { orgId: companyId, galleryId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canEdit = await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) throw new Error("Forbidden: You cannot edit organization profile");

        await client.query(
            `DELETE FROM organization_gallery WHERE org_id = $1 AND gallery_id = $2`,
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

// --- Uploads (Logo & Cover) ---

exports.uploadLogo = async (req, res) => {
    const { orgId: companyId } = req.params;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const logoUrl = req.file.path;
        await client.query(`UPDATE organizations SET logo_url = $1 WHERE org_id = $2`, [logoUrl, companyId]);

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
    const { orgId: companyId } = req.params;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const coverUrl = req.file.path;
        await client.query(`UPDATE organizations SET cover_url = $1 WHERE org_id = $2`, [coverUrl, companyId]);

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
    const { orgId: companyId } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`UPDATE organizations SET logo_url = NULL WHERE org_id = $1`, [companyId]);

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
    const { orgId: companyId } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`UPDATE organizations SET cover_url = NULL WHERE org_id = $1`, [companyId]);

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
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT events_enabled, jobs_enabled, posts_enabled, updated_at
             FROM organization_notification_preferences
             WHERE user_id = $1 AND org_id = $2`,
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
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { events_enabled, jobs_enabled, posts_enabled } = req.body;

    try {
        // Verify user follows the company
        const followCheck = await pool.query(
            `SELECT 1 FROM organization_followers WHERE user_id = $1 AND org_id = $2`,
            [userId, companyId]
        );

        if (followCheck.rowCount === 0) {
            return res.status(403).json({ message: "You must follow this organization to set notification preferences" });
        }

        // Upsert preferences
        const getVal = (val) => val !== undefined ? Boolean(val) : null;

        const result = await pool.query(
            `INSERT INTO organization_notification_preferences (user_id, org_id, events_enabled, jobs_enabled, posts_enabled)
             VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true), COALESCE($5, true))
             ON CONFLICT (user_id, org_id)
             DO UPDATE SET
                events_enabled = COALESCE($3, organization_notification_preferences.events_enabled),
                jobs_enabled = COALESCE($4, organization_notification_preferences.jobs_enabled),
                posts_enabled = COALESCE($5, organization_notification_preferences.posts_enabled),
                updated_at = NOW()
             RETURNING *`,
            [userId, companyId, getVal(events_enabled), getVal(jobs_enabled), getVal(posts_enabled)]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Update notification preferences error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// --- Account Settings & Lifecycle (Owner Restricted) ---

exports.getAccountSettings = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    try {
        const result = await pool.query(
            `SELECT o.org_id, o.email, o.phone, o.is_deactivated, o.deactivated_at,
                    o.entity_type, o.name, o.created_by, u.full_name AS owner_name
             FROM organizations o
             LEFT JOIN users u ON o.created_by = u.user_id
             WHERE o.org_id = $1 AND o.is_deleted = FALSE`,
            [orgId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }

        const org = result.rows[0];
        res.json({
            id: org.org_id,
            email: org.email || "",
            phone: org.phone || "",
            isDeactivated: org.is_deactivated || false,
            deactivatedAt: org.deactivated_at || null,
            entityType: org.entity_type || "COMPANY",
            companyName: org.name,
            ownerUserId: org.created_by,
            ownerName: org.owner_name || "",
            hasCompanyAccount: true,
        });
    } catch (err) {
        console.error("Get org account settings error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deactivateOrganization = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Owner Check
        const orgRes = await client.query(
            `SELECT created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Organization not found" });
        }

        const isOwner = orgRes.rows[0].created_by === userId || (req.actor && req.actor.roleName === 'Owner');
        if (!isOwner) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the organization owner can deactivate the organization page" });
        }

        await client.query(
            `UPDATE organizations SET is_deactivated = true, deactivated_at = NOW() WHERE org_id = $1`,
            [orgId]
        );

        await logAudit(client, {
            entityId: orgId,
            entityType: 'ORGANIZATION',
            actorId: userId,
            action: 'ORGANIZATION_DEACTIVATED',
            metadata: {}
        });

        await client.query("COMMIT");
        res.json({ success: true, message: "Organization page deactivated" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Deactivate organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.reactivateOrganization = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Owner Check
        const orgRes = await client.query(
            `SELECT created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Organization not found" });
        }

        if (orgRes.rows[0].created_by !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the organization owner can reactivate the organization page" });
        }

        await client.query(
            `UPDATE organizations SET is_deactivated = false, deactivated_at = NULL WHERE org_id = $1`,
            [orgId]
        );

        await logAudit(client, {
            entityId: orgId,
            entityType: 'ORGANIZATION',
            actorId: userId,
            action: 'ORGANIZATION_REACTIVATED',
            metadata: {}
        });

        await client.query("COMMIT");
        res.json({ success: true, message: "Organization page reactivated" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Reactivate organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};
