const pool = require("../../core/db/pool");
const { checkOrgPermission } = require("../../core/utils/rbac");
const socketService = require("../../core/infrastructure/socket.service");
const { sendOrgDocumentSubmittedEmail } = require("../../core/services/email.service");
const { sendToUser } = require("../notification/notification.service");

const MONTH_MAP = { 
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", 
    "May": "05", "Jun": "06", "Jul": "07", "Aug": "08", 
    "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12" 
};

// Helper for Audit Logging
const logAudit = async (client, { entityId, actorId, action, metadata = {} }) => {
    const query = `
    INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `;
    await client.query(query, ['ORGANIZATION', entityId, actorId, action, metadata]);
};

const EDU_DOMAINS = [
    /\.edu$/i,
    /\.edu\.[a-z]{2}$/i,      // .edu.in, .edu.br, etc.
    /\.ac\.[a-z]{2}$/i,       // .ac.in, .ac.uk, etc.
    /\.edu\.au$/i,
    /\.university$/i
];

function isEducationalEmail(email) {
    if (!email || !email.includes('@')) return false;
    const domain = email.split('@')[1];
    return EDU_DOMAINS.some(regex => regex.test(domain));
}

exports.verifyDomain = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user.sub;
    const { domain, otp } = req.body; // e.g. "walstartech.com", otp optional for initial request

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. RBAC (OWNER ONLY)
        const isOwner = await checkOrgPermission(client, companyId, userId, '*');
        if (!isOwner) throw new Error("Forbidden: Only OWNER can verify domain");

        // PHASE 2: Verify OTP if provided
        if (otp) {
            const verifyRes = await client.query(
                `SELECT * FROM organization_verifications 
                 WHERE org_id = $1 AND otp = $2
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
                `UPDATE organizations SET verification_status = 'DOMAIN_VERIFIED' WHERE org_id = $1`,
                [companyId]
            );
            await client.query(
                `UPDATE organization_verifications SET is_verified = TRUE WHERE verification_id = $1`,
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
            `SELECT 1 FROM organizations 
             WHERE verification_status = 'DOMAIN_VERIFIED' 
               AND website ILIKE $1 
               AND org_id != $2`,
            [domainParam, companyId]
        );
        if (dupCheck.rowCount > 0) {
            console.warn(`Soft rule warning: Domain ${domain} already verified for another organization.`);
        }

        // 3. Generate Mock OTP
        const newOtp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

        await client.query(
            `INSERT INTO organization_verifications (org_id, otp, expires_at) VALUES ($1, $2, $3)`,
            [companyId, newOtp, expiresAt]
        );

        // Update status to PENDING
        await client.query(
            `UPDATE organizations SET verification_status = 'DOMAIN_PENDING' WHERE org_id = $1`,
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

exports.verifyByEduEmail = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { email, otp } = req.body;

    if (!email) return res.status(400).json({ message: "Email is required" });

    if (!isEducationalEmail(email)) {
        return res.status(400).json({ message: "Only .edu or valid educational emails are allowed for this method" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // RBAC Check (OWNER/ADMIN)
        const canVerify = await checkOrgPermission(client, orgId, userId, 'MANAGE_SETTINGS');
        if (!canVerify) throw new Error("Forbidden: Insufficient permissions");

        if (otp) {
            const verifyRes = await client.query(
                `SELECT * FROM organization_verifications 
                 WHERE org_id = $1 AND otp = $2
                 AND verification_type = 'EDU_EMAIL'
                 AND expires_at > NOW() 
                 AND is_verified = FALSE
                 ORDER BY created_at DESC LIMIT 1`,
                [orgId, otp]
            );

            if (verifyRes.rowCount === 0) throw new Error("Invalid or expired OTP");

            await client.query(
                `UPDATE organizations SET verification_status = 'VERIFIED', verified_edu = TRUE WHERE org_id = $1`,
                [orgId]
            );
            await client.query(
                `UPDATE organization_verifications SET is_verified = TRUE WHERE verification_id = $1`,
                [verifyRes.rows[0].verification_id]
            );

            await logAudit(client, {
                entityId: orgId,
                actorId: userId,
                action: 'EDU_VERIFIED',
                metadata: { email }
            });

            await client.query("COMMIT");
            return res.json({ message: "Institution verified successfully via EDU email!" });
        }

        const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await client.query(
            `INSERT INTO organization_verifications (org_id, otp, expires_at, verification_type) VALUES ($1, $2, $3, 'EDU_EMAIL')`,
            [orgId, newOtp, expiresAt]
        );

        await client.query(
            `UPDATE organizations SET verification_status = 'DOMAIN_PENDING' WHERE org_id = $1`,
            [orgId]
        );

        await client.query("COMMIT");
        console.log(`[EDU VERIFICATION] OTP for ${email}: ${newOtp}`);
        res.json({ message: "Verification OTP sent to educational email", otp: newOtp });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("EDU verify error:", err);
        res.status(err.message.startsWith("Forbidden") ? 403 : 400).json({ message: err.message });
    } finally {
        client.release();
    }
};

exports.submitDocumentVerification = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { documentUrls, legalName, incorporationDay, incorporationMonth, incorporationYear } = req.body; // Array of URLs (fallback)
    let finalUrls = [];

    if (req.files) {
        if (req.files.document) {
            req.files.document.forEach(doc => {
                finalUrls.push(doc.path || doc.location);
            });
        }
    }

    if (finalUrls.length === 0 && documentUrls && Array.isArray(documentUrls)) {
        finalUrls = documentUrls;
    }

    if (finalUrls.length < 1) {
        return res.status(400).json({ message: "At least one verification document is required" });
    }

    if (!legalName || !incorporationDay || !incorporationMonth || !incorporationYear) {
        return res.status(400).json({ message: "Company Full Legal Name and Date of Incorporation are required" });
    }

    const monthNum = MONTH_MAP[incorporationMonth] || "01";
    const incorpDateStr = `${incorporationYear}-${monthNum}-${String(incorporationDay).padStart(2, '0')}`;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const canVerify = await checkOrgPermission(client, orgId, userId, 'MANAGE_SETTINGS');
        if (!canVerify) throw new Error("Forbidden");

        await client.query(
            `UPDATE organizations 
             SET verification_status = 'VERIFIED', 
                 legal_name = $2, 
                 incorporation_date = $3 
             WHERE org_id = $1`,
            [orgId, legalName, incorpDateStr]
        );

        await client.query(
            `INSERT INTO organization_verifications (org_id, verification_type, document_urls, is_verified, legal_name, incorporation_date)
             VALUES ($1, 'DOCUMENT', $2, TRUE, $3, $4)`,
            [orgId, JSON.stringify(finalUrls), legalName, incorpDateStr]
        );

        await logAudit(client, {
            entityId: orgId,
            actorId: userId,
            action: 'DOCUMENTS_SUBMITTED',
            metadata: { count: finalUrls.length, legalName, incorporationDate: incorpDateStr }
        });

        // NOTIFICATION: Document Submitted
        let orgName = "the company";
        const orgRes = await client.query("SELECT name, created_by FROM organizations WHERE org_id = $1", [orgId]);
        if (orgRes.rowCount > 0) {
            orgName = orgRes.rows[0].name;
            const ownerId = orgRes.rows[0].created_by;
            const userRes = await client.query("SELECT email FROM active_users WHERE user_id = $1", [ownerId]);
            
            if (userRes.rowCount > 0) {
                const ownerEmail = userRes.rows[0].email;
                const type = "org_doc_verification_submitted";
                const title = "Documents submitted";
                const message = `Your documents for "${orgName}" have been submitted and are under review.`;
                const timestamp = new Date().toISOString();

                // Insert into DB
                const notifRes = await client.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, metadata, recipient_org_id)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING notification_id, created_at`,
                    [ownerId, ownerId, type, message, JSON.stringify({ title, orgId }), orgId]
                );

                // Socket notification (triggers toast in frontend)
                socketService.notifyUser(ownerId, "notification", { 
                    type, 
                    title, 
                    message, 
                    timestamp,
                    notification_id: notifRes.rows[0].notification_id,
                    created_at: notifRes.rows[0].created_at.toISOString(),
                    recipient_org_id: orgId
                });

                // Email notification
                sendOrgDocumentSubmittedEmail(ownerEmail, orgName).catch(err => console.error("Email err:", err));
                
                // Push notification
                sendToUser(ownerId, title, message, { type }).catch(() => {});
            }
        }

        await client.query("COMMIT");
        res.json({ message: `Your documents for ${orgName} have been submitted and are under review.` });
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(err.message === "Forbidden" ? 403 : 500).json({ message: err.message });
    } finally {
        client.release();
    }
};

exports.getVerificationQueue = async (req, res) => {
    // This expects global Admin role, handled by route middleware
    try {
        const result = await pool.query(
            `SELECT o.org_id, o.name, o.verification_status, o.created_at,
                    ov.verification_id, ov.document_urls, ov.verification_type
             FROM organizations o
             JOIN organization_verifications ov ON o.org_id = ov.org_id
             WHERE o.verification_status IN ('DOCUMENT_PENDING', 'UNDER_REVIEW')
             AND ov.is_verified = FALSE
             ORDER BY o.created_at ASC`
        );
        res.json({ queue: result.rows });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.reviewVerification = async (req, res) => {
    const adminId = req.user.sub;
    const { verificationId } = req.params;
    const { status, notes } = req.body; // 'VERIFIED' or 'REJECTED'

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
        return res.status(400).json({ message: "Invalid status. Use VERIFIED or REJECTED" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const vRes = await client.query(`SELECT org_id FROM organization_verifications WHERE verification_id = $1`, [verificationId]);
        if (vRes.rowCount === 0) throw new Error("Verification record not found");
        const orgId = vRes.rows[0].org_id;

        await client.query(
            `UPDATE organizations 
             SET verification_status = $1, review_notes = $2, reviewed_by = $3, reviewed_at = NOW()
             WHERE org_id = $4`,
            [status, notes, adminId, orgId]
        );

        await client.query(
            `UPDATE organization_verifications SET is_verified = $1 WHERE verification_id = $2`,
            [status === 'VERIFIED', verificationId]
        );

        await logAudit(client, {
            entityId: orgId,
            actorId: adminId,
            action: `VERIFICATION_${status}`,
            metadata: { notes }
        });

        await client.query("COMMIT");
        res.json({ message: `Verification ${status.toLowerCase()} successfully` });
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(400).json({ message: err.message });
    } finally {
        client.release();
    }
};
