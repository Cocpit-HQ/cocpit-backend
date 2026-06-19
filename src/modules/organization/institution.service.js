/**
 * Institution Service
 * Handles enrollment logic (Student / Faculty / Alumni onboarding)
 */
const pool = require("../../core/db/pool");
const { logAudit } = require("../../core/infrastructure/audit.service");

class InstitutionService {
    /**
     * Request enrollment into an institution
     */
    async requestEnrollment(userId, orgId, role, method, documentUrl = null) {
        const client = await pool.connect();
        try {
            // Check if already enrolled or pending
            const existing = await client.query(
                `SELECT status FROM institution_enrollments WHERE org_id = $1 AND user_id = $2`,
                [orgId, userId]
            );

            if (existing.rowCount > 0) {
                const status = existing.rows[0].status;
                if (status === 'PENDING') throw new Error("Enrollment request already pending");
                if (status === 'VERIFIED') throw new Error("User is already enrolled in this institution");
            }

            // Insert request
            const res = await client.query(
                `INSERT INTO institution_enrollments (org_id, user_id, role, verification_method, document_url, status)
                 VALUES ($1, $2, $3, $4, $5, 'PENDING')
                 RETURNING *`,
                [orgId, userId, role, method, documentUrl]
            );

            await logAudit(client, {
                entityId: orgId,
                actorId: userId,
                action: 'REQUEST_ENROLLMENT',
                metadata: { role, method }
            });

            return res.rows[0];
        } finally {
            client.release();
        }
    }

    /**
     * Admin: Approve or reject an enrollment request
     */
    async reviewEnrollment(adminId, enrollmentId, action) {
        // action should be 'VERIFIED' or 'REJECTED'
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const enrollmentRes = await client.query(
                `SELECT org_id, user_id, role, status FROM institution_enrollments WHERE enrollment_id = $1`,
                [enrollmentId]
            );

            if (enrollmentRes.rowCount === 0) throw new Error("Enrollment not found");
            const enrollment = enrollmentRes.rows[0];

            if (enrollment.status !== 'PENDING') throw new Error(`Enrollment is already ${enrollment.status}`);

            // Update status
            const updateRes = await client.query(
                `UPDATE institution_enrollments 
                 SET status = $1, verified_at = ${action === 'VERIFIED' ? 'NOW()' : 'NULL'} 
                 WHERE enrollment_id = $2 RETURNING *`,
                [action, enrollmentId]
            );

            // If APPROVED, add to organization_members with the appropriate role
            if (action === 'VERIFIED') {
                // Find target role ID based on the enrollment role (e.g., 'STUDENT' -> 'Student')
                // Role names map directly: STUDENT -> Student, FACULTY -> Faculty, etc.
                const mappedRoleName = enrollment.role.charAt(0).toUpperCase() + enrollment.role.slice(1).toLowerCase();

                const roleRes = await client.query(
                    `SELECT role_id FROM organization_roles WHERE org_id = $1 AND name = $2`,
                    [enrollment.org_id, mappedRoleName]
                );

                if (roleRes.rowCount === 0) {
                    throw new Error(`Role ${mappedRoleName} not found in this institution`);
                }

                await client.query(
                    `INSERT INTO organization_members (org_id, user_id, role_id, status)
                     VALUES ($1, $2, $3, 'ACTIVE')
                     ON CONFLICT (org_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = 'ACTIVE'`,
                    [enrollment.org_id, enrollment.user_id, roleRes.rows[0].role_id]
                );
            }

            // Log action
            await logAudit(client, {
                entityId: enrollment.org_id,
                actorId: adminId,
                action: action === 'VERIFIED' ? 'APPROVE_ENROLLMENT' : 'REJECT_ENROLLMENT',
                metadata: { targetUserId: enrollment.user_id, enrollmentId }
            });

            await client.query("COMMIT");
            return updateRes.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get pending enrollments for an org
     */
    async getPendingEnrollments(orgId) {
        const client = await pool.connect();
        try {
            const res = await client.query(
                `SELECT e.*, u.full_name, u.avatar_url, u.email 
                 FROM institution_enrollments e
                 JOIN active_users u ON e.user_id = u.user_id
                 WHERE e.org_id = $1 AND e.status = 'PENDING'
                 ORDER BY e.created_at DESC`,
                [orgId]
            );
            return res.rows;
        } finally {
            client.release();
        }
    }
}

module.exports = new InstitutionService();
