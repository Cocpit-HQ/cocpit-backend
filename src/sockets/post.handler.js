const { getPostRoom } = require("../core/utils/socketRooms");

module.exports.registerPostHandlers = (io, socket) => {
    // Join Post Room for Real-Time Updates (Comments/Likes)
    socket.on("joinPost", (payload) => {
        try {
            const postId = typeof payload === "string" ? payload : payload?.postId;
            if (!postId) return;

            const room = getPostRoom(postId);
            socket.join(room);
        } catch (err) {
            console.error("Error joining post room:", err);
        }
    });

    // Leave Post Room
    socket.on("leavePost", (payload) => {
        try {
            const postId = typeof payload === "string" ? payload : payload?.postId;
            if (!postId) return;

            const room = getPostRoom(postId);
            socket.leave(room);
        } catch (err) {
            console.error("Error leaving post room:", err);
        }
    });
};
