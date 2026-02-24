const { getStoryRoom } = require("../utils/socketRooms");

module.exports.registerStoryHandlers = (io, socket) => {
    // Join Story Room for Real-Time Updates (Comments/Likes)
    socket.on("joinStory", (payload) => {
        try {
            const storyId = typeof payload === "string" ? payload : payload?.storyId;
            if (!storyId) return;

            const room = getStoryRoom(storyId);
            socket.join(room);
        } catch (err) {
            console.error("Error joining story room:", err);
        }
    });

    // Leave Story Room
    socket.on("leaveStory", (payload) => {
        try {
            const storyId = typeof payload === "string" ? payload : payload?.storyId;
            if (!storyId) return;

            const room = getStoryRoom(storyId);
            socket.leave(room);
        } catch (err) {
            console.error("Error leaving story room:", err);
        }
    });
};
