/**
 * organization.hierarchy.controller.js
 *
 * Handles the parent-child relationship between organizations.
 * All write operations go through a request/approval flow.
 *
 * Routes (registered in organization.routes.js):
 *   POST   /organizations/:orgId/parent-request     → sendParentRequest
 *   GET    /organizations/:orgId/parent-requests     → getPendingParentRequests
 *   PATCH  /organizations/:orgId/parent-requests/:requestId → respondToParentRequest
 *   DELETE /organizations/:orgId/parent             → removeParent
 *   GET    /organizations/:orgId/children           → getOrganizationChildren
 */

const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { checkOrgPermission } = require("../../core/utils/rbac");

// ---------------------------------------------------------------------------
// Helper: Cycle Detection
// Walks up the ancestor chain from `newParentId`.
// Returns true if `orgId` appears anywhere in that chain (→ would create cycle).
// ---------------------------------------------------------------------------
async function wouldCreateCycle(client, orgId, newParentId) {
    if (orgId === newParentId) return true; // trivial self-loop

    const result = await client.query(
        `WITH RECURSIVE ancestors AS (
            SELECT org_id, parent_org_id
            FROM organizations
            WHERE org_id = $1 AND is_deleted = FALSE
            UNION ALL
            SELECT o.org_id, o.parent_org_id
            FROM organizations o
            JOIN ancestors a ON o.org_id = a.parent_org_id
            WHERE a.parent_org_id IS NOT NULL AND o.is_deleted = FALSE
        )
        SELECT 1 FROM ancestors WHERE org_id = $2 LIMIT 1`,
        [newParentId, orgId]
    );
    return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Helper: Validate parent org is eligible
// - Must exist and not be deleted
// - Must not itself have a parent (MVP: max 1 level deep)
// ---------------------------------------------------------------------------
async function validateParentOrg(client, parentOrgId) {
    const result = await client.query(
        `SELECT org_id, is_deleted, parent_org_id FROM organizations WHERE org_id = $1`,
        [parentOrgId]
    );
    if (result.rowCount === 0) throw new AppError("Parent organization not found", 404);
    const parent = result.rows[0];
    if (parent.is_deleted) throw new AppError("Cannot link to a deleted organization", 400);
    if (parent.parent_org_id) {
        throw new AppError(
            "The target organization is already a sub-organization. Nesting beyond one level is not supported yet.",
            400
        );
    }
    return parent;
}

// ---------------------------------------------------------------------------
// POST /organizations/:orgId/parent-request
// Child org owner sends a request to join under a parent org.
// Body: { parent_org_id, message? }
// ---------------------------------------------------------------------------
exports.sendParentRequest = async (req, res) => {
    const { orgId } = req.params; // this is the CHILD org
    const { parent_org_id, message } = req.body;
    const userId = req.user.sub;

    if (!parent_org_id) throw new AppError("parent_org_id is required", 400);
    if (orgId === parent_org_id) throw new AppError("An organization cannot be its own parent", 400);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Requester must have MANAGE_COMPANY permission in the child org
        const canManage = await checkOrgPermission(client, orgId, userId, "MANAGE_COMPANY");
        if (!canManage) throw new AppError("You do not have permission to manage this organization", 403);

        // 2. Child org must not already have a parent
        const childRes = await client.query(
            `SELECT org_id, parent_org_id, is_deleted FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (childRes.rowCount === 0 || childRes.rows[0].is_deleted) {
            throw new AppError("Organization not found", 404);
        }
        if (childRes.rows[0].parent_org_id) {
            throw new AppError(
                "This organization already has a parent. Remove the existing parent first.",
                409
            );
        }

        // 3. Validate the proposed parent
        await validateParentOrg(client, parent_org_id);

        // 4. Cycle check
        const hasCycle = await wouldCreateCycle(client, orgId, parent_org_id);
        if (hasCycle) throw new AppError("This association would create a circular hierarchy", 409);

        // 5. Upsert request (UNIQUE(child_org_id) means only one active request at a time)
        const result = await client.query(
            `INSERT INTO org_parent_requests (child_org_id, parent_org_id, requested_by, message)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (child_org_id) DO UPDATE
                SET parent_org_id = EXCLUDED.parent_org_id,
                    requested_by  = EXCLUDED.requested_by,
                    message       = EXCLUDED.message,
                    status        = 'PENDING',
                    updated_at    = NOW()
             RETURNING *`,
            [orgId, parent_org_id, userId, message || null]
        );

        await client.query("COMMIT");
        res.status(201).json({
            message: "Parent request sent. Waiting for the parent organization to approve.",
            request: result.rows[0],
        });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err instanceof AppError) return res.status(err.statusCode).json({ message: err.message });
        console.error("[sendParentRequest]", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// GET /organizations/:orgId/parent-requests
// Parent org admin sees all pending incoming requests.
// ---------------------------------------------------------------------------
exports.getPendingParentRequests = async (req, res) => {
    const { orgId } = req.params; // this is the PARENT org
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        // Must have MANAGE_MEMBERS permission in the parent org
        const canManage = await checkOrgPermission(client, orgId, userId, "MANAGE_MEMBERS");
        if (!canManage) throw new AppError("Forbidden", 403);

        const result = await client.query(
            `SELECT
                opr.*,
                json_build_object(
                    'org_id',   co.org_id,
                    'name',     co.name,
                    'slug',     co.slug,
                    'logo_url', co.logo_url,
                    'industry', co.industry,
                    'entity_type', co.entity_type
                ) AS child_org,
                json_build_object(
                    'user_id',  u.user_id,
                    'full_name', u.full_name,
                    'avatar_url', u.avatar_url
                ) AS requested_by_user
             FROM org_parent_requests opr
             JOIN organizations co ON co.org_id = opr.child_org_id AND co.is_deleted = FALSE
             JOIN active_users u ON u.user_id = opr.requested_by
             WHERE opr.parent_org_id = $1 AND opr.status = 'PENDING'
             ORDER BY opr.created_at DESC`,
            [orgId]
        );

        res.json(result.rows);
    } catch (err) {
        if (err instanceof AppError) return res.status(err.statusCode).json({ message: err.message });
        console.error("[getPendingParentRequests]", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// PATCH /organizations/:orgId/parent-requests/:requestId
// Parent org admin approves or rejects a request.
// Body: { action: 'ACCEPT' | 'REJECT' }
// ---------------------------------------------------------------------------
exports.respondToParentRequest = async (req, res) => {
    const { orgId, requestId } = req.params; // orgId = PARENT
    const { action } = req.body;
    const userId = req.user.sub;

    if (!["ACCEPT", "REJECT"].includes(action)) {
        throw new AppError("action must be ACCEPT or REJECT", 400);
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Permission check on the parent org
        const canManage = await checkOrgPermission(client, orgId, userId, "MANAGE_MEMBERS");
        if (!canManage) throw new AppError("Forbidden", 403);

        // 2. Fetch the request — must belong to this parent org and be PENDING
        const reqRes = await client.query(
            `SELECT * FROM org_parent_requests
             WHERE request_id = $1 AND parent_org_id = $2 AND status = 'PENDING'`,
            [requestId, orgId]
        );
        if (reqRes.rowCount === 0) {
            throw new AppError("Request not found or already resolved", 404);
        }
        const parentRequest = reqRes.rows[0];

        if (action === "ACCEPT") {
            // 3a. Re-validate parent eligibility (may have changed since request was sent)
            await validateParentOrg(client, orgId);

            // 3b. Re-run cycle check (defensive)
            const hasCycle = await wouldCreateCycle(client, parentRequest.child_org_id, orgId);
            if (hasCycle) {
                throw new AppError("Cannot approve: this would create a circular hierarchy", 409);
            }

            // 3c. Confirm child still has no parent
            const childRes = await client.query(
                `SELECT parent_org_id FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [parentRequest.child_org_id]
            );
            if (childRes.rowCount === 0) throw new AppError("Child organization no longer exists", 404);
            if (childRes.rows[0].parent_org_id) {
                throw new AppError("Child organization already has a parent. Reject this request.", 409);
            }

            // 3d. Set the parent
            await client.query(
                `UPDATE organizations SET parent_org_id = $1, updated_at = NOW() WHERE org_id = $2`,
                [orgId, parentRequest.child_org_id]
            );

            // 3e. Audit log on both orgs
            const logAudit = async (entityId, action, metadata) => {
                await client.query(
                    `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
                     VALUES ('ORGANIZATION', $1, $2, $3, $4)`,
                    [entityId, userId, action, metadata]
                );
            };
            await logAudit(orgId, "PARENT_REQUEST_ACCEPTED", { child_org_id: parentRequest.child_org_id });
            await logAudit(parentRequest.child_org_id, "SET_PARENT", { parent_org_id: orgId });
        }

        // 4. Update request status
        await client.query(
            `UPDATE org_parent_requests SET status = $1, updated_at = NOW() WHERE request_id = $2`,
            [action === "ACCEPT" ? "ACCEPTED" : "REJECTED", requestId]
        );

        await client.query("COMMIT");

        res.json({
            message: action === "ACCEPT"
                ? "Organization is now linked as a sub-organization."
                : "Request rejected.",
        });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err instanceof AppError) return res.status(err.statusCode).json({ message: err.message });
        console.error("[respondToParentRequest]", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// DELETE /organizations/:orgId/parent
// Child org owner removes their parent association.
// ---------------------------------------------------------------------------
exports.removeParent = async (req, res) => {
    const { orgId } = req.params; // this is the CHILD org
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const canManage = await checkOrgPermission(client, orgId, userId, "MANAGE_COMPANY");
        if (!canManage) throw new AppError("Forbidden", 403);

        const orgRes = await client.query(
            `SELECT parent_org_id FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );
        if (orgRes.rowCount === 0) throw new AppError("Organization not found", 404);
        if (!orgRes.rows[0].parent_org_id) throw new AppError("This organization has no parent", 400);

        const previousParentId = orgRes.rows[0].parent_org_id;

        await client.query(
            `UPDATE organizations SET parent_org_id = NULL, updated_at = NOW() WHERE org_id = $1`,
            [orgId]
        );

        // Clean up any lingering ACCEPTED request record
        await client.query(
            `DELETE FROM org_parent_requests WHERE child_org_id = $1 AND status = 'ACCEPTED'`,
            [orgId]
        );

        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
             VALUES ('ORGANIZATION', $1, $2, 'REMOVE_PARENT', $3)`,
            [orgId, userId, { previous_parent_org_id: previousParentId }]
        );

        await client.query("COMMIT");
        res.json({ message: "Parent organization removed successfully." });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err instanceof AppError) return res.status(err.statusCode).json({ message: err.message });
        console.error("[removeParent]", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// GET /organizations/:orgId/children
// Public: list all sub-organizations of a given org.
// ---------------------------------------------------------------------------
exports.getOrganizationChildren = async (req, res) => {
    const { orgId } = req.params;

    try {
        const result = await pool.query(
            `SELECT
                o.org_id,
                o.name,
                o.slug,
                o.logo_url,
                o.industry,
                o.entity_type,
                o.size,
                o.location,
                o.description,
                o.verification_status,
                (SELECT COUNT(*) FROM organization_members om WHERE om.org_id = o.org_id AND om.status = 'ACTIVE') AS member_count
             FROM organizations o
             WHERE o.parent_org_id = $1
               AND o.is_deleted = FALSE
             ORDER BY o.name`,
            [orgId]
        );

        res.json({
            parent_org_id: orgId,
            children: result.rows,
            total: result.rowCount,
        });
    } catch (err) {
        console.error("[getOrganizationChildren]", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ---------------------------------------------------------------------------
// Export the cycle-check helper for use in organization.controller.js
// ---------------------------------------------------------------------------
exports.wouldCreateCycle = wouldCreateCycle;
