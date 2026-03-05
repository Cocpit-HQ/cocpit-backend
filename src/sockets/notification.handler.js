const pool = require("../core/db/pool");
const { getOrgRoom } = require("../core/utils/socketRooms");

module.exports.registerNotificationHandlers = (io, socket) => {
    const userId = socket.userId;

    // Join a specific organization's notification room
    socket.on("joinOrgRoom", async (payload) => {
        try {
            const orgId = typeof payload === "string" ? payload : payload?.orgId || payload?.companyId;
            if (!orgId) return;

            // UUID validation
            const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
            if (!uuidRegex.test(orgId)) {
                socket.emit("error", { message: "Invalid organization ID" });
                return;
            }

            // Verify user is a member of this organization
            const result = await pool.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [orgId, userId]
            );

            if (result.rowCount > 0) {
                const room = getOrgRoom(orgId);
                socket.join(room);
                console.log(`Socket ${socket.id} joined organization room: ${room}`);
            } else {
                socket.emit("error", { message: "Unauthorized: Not an organization member" });
            }
        } catch (err) {
            console.error("Error joining organization room:", err);
        }
    });

    // Backward compatibility alias
    socket.on("joinCompanyRoom", (payload) => {
        // We can't easily "redirect" because joinOrgRoom is async and this is a listener
        // But we can call the same logic or just trigger it
        const orgId = typeof payload === "string" ? payload : payload?.companyId;
        if (orgId) {
            socket.emit("info", { message: "joinCompanyRoom is deprecated, use joinOrgRoom" });
            // We can manually call join if we want or just let the user switch
        }
    });

    // Leave a specific organization's notification room
    socket.on("leaveOrgRoom", (payload) => {
        try {
            const orgId = typeof payload === "string" ? payload : payload?.orgId || payload?.companyId;
            if (!orgId) return;

            const room = getOrgRoom(orgId);
            socket.leave(room);
        } catch (err) {
            console.error("Error leaving organization room:", err);
        }
    });

    socket.on("leaveCompanyRoom", (payload) => {
        const orgId = typeof payload === "string" ? payload : payload?.companyId;
        if (orgId) {
            socket.leave(getOrgRoom(orgId));
        }
    });
};

/**
 * Auto-join all organization rooms for a user on socket connect.
 * Called once during connection setup.
 */
module.exports.autoJoinOrgRooms = async (socket) => {
    try {
        const userId = socket.userId;
        const result = await pool.query(
            `SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'ACTIVE'`,
            [userId]
        );

        for (const row of result.rows) {
            const room = getOrgRoom(row.org_id);
            socket.join(room);
        }
    } catch (err) {
        console.error("Error auto-joining organization rooms:", err);
    }
};

module.exports.autoJoinCompanyRooms = module.exports.autoJoinOrgRooms; // Legacy alias
