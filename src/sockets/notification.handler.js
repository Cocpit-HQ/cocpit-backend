const pool = require("../core/db/pool");
const { getCompanyRoom } = require("../core/utils/socketRooms");

module.exports.registerNotificationHandlers = (io, socket) => {
    const userId = socket.userId;

    // Join a specific company's notification room
    socket.on("joinCompanyRoom", async (payload) => {
        try {
            const companyId = typeof payload === "string" ? payload : payload?.companyId;
            if (!companyId) return;

            // UUID validation
            const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
            if (!uuidRegex.test(companyId)) {
                socket.emit("error", { message: "Invalid company ID" });
                return;
            }

            // Verify user is a member of this company
            const result = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [companyId, userId]
            );

            if (result.rowCount > 0) {
                const room = getCompanyRoom(companyId);
                socket.join(room);
            } else {
                socket.emit("error", { message: "Unauthorized: Not a company member" });
            }
        } catch (err) {
            console.error("Error joining company room:", err);
        }
    });

    // Leave a specific company's notification room
    socket.on("leaveCompanyRoom", (payload) => {
        try {
            const companyId = typeof payload === "string" ? payload : payload?.companyId;
            if (!companyId) return;

            const room = getCompanyRoom(companyId);
            socket.leave(room);
        } catch (err) {
            console.error("Error leaving company room:", err);
        }
    });
};

/**
 * Auto-join all company rooms for a user on socket connect.
 * Called once during connection setup.
 */
module.exports.autoJoinCompanyRooms = async (socket) => {
    try {
        const userId = socket.userId;
        const result = await pool.query(
            `SELECT company_id FROM company_members WHERE user_id = $1 AND status = 'ACTIVE'`,
            [userId]
        );

        for (const row of result.rows) {
            const room = getCompanyRoom(row.company_id);
            socket.join(room);
        }
    } catch (err) {
        console.error("Error auto-joining company rooms:", err);
    }
};
