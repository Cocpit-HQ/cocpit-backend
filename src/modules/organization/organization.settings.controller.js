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

exports.sendDeactivateOrgOTP = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            "SELECT name, email, created_by, is_deactivated FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }
        const org = orgRes.rows[0];

        const isOwner = org.created_by === userId || (req.actor && req.actor.roleName === 'Owner');
        if (!isOwner) {
            return res.status(403).json({ message: "Only the organization owner can request deactivation code" });
        }

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
            return res.status(400).json({ message: "No registered email address found for this organization owner" });
        }

        const primaryEmail = recipients[0];

        // Rate Limit & Cooldown Check
        const existing = await client.query(
            `SELECT created_at, request_count FROM email_otps WHERE email = $1 AND purpose = 'org_deactivation'`,
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
            `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count, purpose)
             VALUES ($1, $2, $3, 0, NOW(), 1, 'org_deactivation')
             ON CONFLICT (email, purpose)
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
                `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count, purpose)
                 VALUES ($1, $2, $3, 0, NOW(), 1, 'org_deactivation')
                 ON CONFLICT (email, purpose)
                 DO UPDATE SET
                     otp_hash = EXCLUDED.otp_hash,
                     expires_at = EXCLUDED.expires_at,
                     attempts = 0,
                     created_at = NOW(),
                     request_count = email_otps.request_count + 1`,
                [recipients[1], otpHash, expiresAt]
            );
        }

        const { sendOrgDeactivateOTPEmail } = require("../../core/services/email.service");
        await sendOrgDeactivateOTPEmail(recipients, otp, org.name);

        console.log(`\n==================================================`);
        console.log(`🔑 [TESTING OTP] ORGANIZATION DEACTIVATION CODE`);
        console.log(`🏢 Organization: "${org.name}" (ID: ${orgId})`);
        console.log(`✉️ Sent To: ${recipients.join(", ")}`);
        console.log(`👉 VERIFICATION CODE (OTP): ${otp}`);
        console.log(`==================================================\n`);

        res.json({
            success: true,
            message: "Verification code sent successfully to your registered email address.",
            email_masked: maskEmailHelper(primaryEmail),
            cooldown_seconds: 30
        });
    } catch (err) {
        console.error("Send deactivate org OTP error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.validateDeactivateOrgOTP = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;
    const { otp } = req.body;

    if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({ message: "A valid 6-digit verification code is required" });
    }

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            "SELECT email, created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }
        const org = orgRes.rows[0];

        const ownerRes = await client.query("SELECT email FROM users WHERE user_id = $1", [org.created_by || userId]);
        const primaryEmail = (org.email || ownerRes.rows[0]?.email || "").toLowerCase().trim();

        const otpRes = await client.query("SELECT * FROM email_otps WHERE email = $1 AND purpose = 'org_deactivation'", [primaryEmail]);
        if (otpRes.rowCount === 0) {
            return res.status(400).json({ message: "No verification code was requested for this email." });
        }

        const record = otpRes.rows[0];
        if (new Date() > new Date(record.expires_at)) {
            return res.status(400).json({ message: "Verification code has expired. Please request a new code." });
        }

        const bcrypt = require("bcrypt");
        const isMatch = await bcrypt.compare(String(otp).trim(), record.otp_hash);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid verification code. Please check and try again." });
        }

        res.json({ success: true, message: "Verification code validated successfully" });
    } catch (err) {
        console.error("Validate deactivate org OTP error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deactivateOrganization = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;
    const { otp } = req.body;

    if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({ message: "Verification code (OTP) is required to deactivate organization" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Owner Check
        const orgRes = await client.query(
            `SELECT created_by, name, email FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Organization not found" });
        }

        const org = orgRes.rows[0];
        const isOwner = org.created_by === userId || (req.actor && req.actor.roleName === 'Owner');
        if (!isOwner) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the organization owner can deactivate the organization page" });
        }

        const ownerRes = await client.query("SELECT email FROM users WHERE user_id = $1", [org.created_by || userId]);
        const primaryEmail = (org.email || ownerRes.rows[0]?.email || "").toLowerCase().trim();

        // Verify OTP
        const otpRes = await client.query("SELECT * FROM email_otps WHERE email = $1 AND purpose = 'org_deactivation'", [primaryEmail]);
        if (otpRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No verification code was requested for this organization." });
        }

        const record = otpRes.rows[0];
        if (new Date() > new Date(record.expires_at)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Verification code has expired. Please request a new code." });
        }

        const bcrypt = require("bcrypt");
        const isMatch = await bcrypt.compare(String(otp).trim(), record.otp_hash);
        if (!isMatch) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Invalid verification code. Please check and try again." });
        }

        // Delete OTP after successful verification
        await client.query("DELETE FROM email_otps WHERE email = $1 AND purpose = 'org_deactivation'", [primaryEmail]);

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

        try {
            const socketService = require("../../core/infrastructure/socket.service");
            if (socketService && socketService.io) {
                socketService.io.emit("ORGANIZATION_DEACTIVATED", { orgId });
                socketService.io.emit("organization_deactivated", { orgId });
                socketService.io.emit("org_status_changed", { orgId, status: "deactivated", action: "deactivated" });
            }
        } catch (sockErr) {
            console.error("[deactivateOrganization] Socket emit error:", sockErr);
        }

        res.json({ success: true, message: "Organization page deactivated successfully" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Deactivate organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

const maskEmailHelper = (email) => {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '';
    const [name, domain] = email.split('@');
    if (name.length <= 2) return `${name.charAt(0)}***@${domain}`;
    return `${name.charAt(0)}***${name.charAt(name.length - 1)}@${domain}`;
};

exports.sendReactivateOrgOTP = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const orgRes = await client.query(
            "SELECT name, email, created_by, is_deactivated FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            return res.status(404).json({ message: "Organization not found" });
        }
        const org = orgRes.rows[0];

        if (org.created_by !== userId) {
            return res.status(403).json({ message: "Only the organization owner can request reactivation code" });
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

        // Rate Limit & Cooldown Check
        const existing = await client.query(
            `SELECT created_at, request_count FROM email_otps WHERE email = $1 AND purpose = 'org_reactivation'`,
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
            `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count, purpose)
             VALUES ($1, $2, $3, 0, NOW(), 1, 'org_reactivation')
             ON CONFLICT (email, purpose)
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
                `INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count, purpose)
                 VALUES ($1, $2, $3, 0, NOW(), 1, 'org_reactivation')
                 ON CONFLICT (email, purpose)
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
        await emailService.sendOrgReactivateOTPEmail(recipients, otp, org.name);

        console.log(`\n==================================================`);
        console.log(`🔑 [TESTING OTP] ORGANIZATION REACTIVATION CODE`);
        console.log(`🏢 Organization: "${org.name}" (ID: ${orgId})`);
        console.log(`✉️ Sent To: ${recipients.join(", ")}`);
        console.log(`👉 VERIFICATION CODE (OTP): ${otp}`);
        console.log(`==================================================\n`);

        const maskedDisplay = recipients.map(maskEmailHelper).join(", ");
        res.json({
            success: true,
            message: "Verification code sent to owner email",
            email_masked: maskedDisplay,
            expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
            cooldown_seconds: 30
        });
    } catch (err) {
        console.error("Send reactivate org OTP error:", err);
        res.status(500).json({ message: err.message || "Failed to send verification code" });
    } finally {
        client.release();
    }
};

exports.reactivateOrganization = async (req, res) => {
    const orgId = req.params.orgId || req.params.companyId;
    const userId = req.user.sub;
    const { otp } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Owner Check
        const orgRes = await client.query(
            `SELECT name, email, created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Organization not found" });
        }

        const org = orgRes.rows[0];
        if (org.created_by !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Only the organization owner can reactivate the organization page" });
        }

        // If OTP is passed, verify it
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
            let otpResult = await verifyOTP(recipients[0], otp, true, "org_reactivation");
            if (otpResult.error && otpResult.error.message.includes("No active OTP found") && recipients.length > 1) {
                otpResult = await verifyOTP(recipients[1], otp, true, "org_reactivation");
            }

            if (otpResult.error) {
                await client.query("ROLLBACK");
                return res.status(otpResult.error.status || 400).json({ message: otpResult.error.message });
            }
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

        // Broadcast real-time socket event to all connected sockets & organization members
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            if (socketService && socketService.io) {
                socketService.io.emit("ORGANIZATION_REACTIVATED", { orgId });
                socketService.io.emit("organization_reactivated", { orgId });
                socketService.io.emit("org_status_changed", { orgId, status: "active", action: "reactivated" });
            }
            const membersRes = await pool.query(`SELECT user_id FROM organization_members WHERE org_id = $1`, [orgId]);
            for (const m of membersRes.rows) {
                socketService.notifyUser(m.user_id, 'org_status_changed', { orgId, status: 'active', action: 'reactivated' });
            }
        } catch (sErr) {
            console.error("[ReactivateOrg] Socket notification error:", sErr);
        }

        res.json({
            success: true,
            message: "Organization page reactivated",
            data: { id: orgId, pageStatus: "active" }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Reactivate organization error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};


