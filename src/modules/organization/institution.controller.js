/**
 * Institution Controller
 * HTTP wrappers for enrollment endpoints
 */
const institutionService = require("./institution.service");

exports.requestEnrollment = async (req, res) => {
    try {
        const userId = req.user.sub;
        const orgId = req.params.orgId; // URL is /api/organizations/:orgId/...
        const { role, method, documentUrl } = req.body;

        if (!role || !['STUDENT', 'FACULTY', 'ALUMNI'].includes(role)) {
            return res.status(400).json({ message: "Invalid or missing role" });
        }
        if (!method || !['EMAIL', 'ID_UPLOAD', 'MANUAL'].includes(method)) {
            return res.status(400).json({ message: "Invalid verification method" });
        }
        if (method === 'ID_UPLOAD' && !documentUrl) {
            return res.status(400).json({ message: "Document URL is required for ID_UPLOAD method" });
        }

        const enrollment = await institutionService.requestEnrollment(userId, orgId, role, method, documentUrl);
        res.status(201).json({ message: "Enrollment request submitted successfully", enrollment });
    } catch (err) {
        console.error("Request enrollment error:", err);
        if (err.message.includes("already")) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.reviewEnrollment = async (req, res) => {
    try {
        const adminId = req.user.sub;
        const { id: enrollmentId } = req.params;
        const { action } = req.body; // 'VERIFIED' or 'REJECTED'

        if (!['VERIFIED', 'REJECTED'].includes(action)) {
            return res.status(400).json({ message: "Action must be VERIFIED or REJECTED" });
        }

        const updated = await institutionService.reviewEnrollment(adminId, enrollmentId, action);
        res.json({ message: `Enrollment ${action.toLowerCase()} successfully`, enrollment: updated });
    } catch (err) {
        console.error("Review enrollment error:", err);
        if (err.message.includes("not found")) return res.status(404).json({ message: err.message });
        res.status(400).json({ message: err.message || "Internal server error" });
    }
};

exports.getPendingEnrollments = async (req, res) => {
    try {
        const orgId = req.params.orgId;
        const pending = await institutionService.getPendingEnrollments(orgId);
        res.json(pending);
    } catch (err) {
        console.error("Get pending enrollments error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
