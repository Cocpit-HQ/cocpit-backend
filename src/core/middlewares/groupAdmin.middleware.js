const pool = require("../db/pool");

/**
 * Middleware to require group admin role for the requesting user.
 * Expects groupId in req.params.groupId or req.body.groupId.
 */
exports.requireGroupAdmin = async (req, res, next) => {
    const userId = req.user.sub || req.user.user_id;
    const groupId = req.params.groupId || req.body.groupId;

    if (!groupId) {
        return res.status(400).json({ message: "Group ID is required" });
    }

    try {
        const result = await pool.query(
            `SELECT role FROM conversation_participants 
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [groupId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(403).json({ message: "Forbidden: Not a member of this group" });
        }

        const { role } = result.rows[0];

        if (role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: Admin privileges required" });
        }

        next();
    } catch (err) {
        console.error("Group Admin Middleware Error:", err);
        res.status(500).json({ message: "Internal server error during permission check" });
    }
};
