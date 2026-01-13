const pool = require("../db/pool");
const socketService = require("../services/socket.service");

async function getRelatedUsers(userId) {
  try {
    // 1. Friends from 'connections' (bidirectional)
    // - If I am user_id, my friend is connected_user_id
    // - If I am connected_user_id, my friend is user_id
    // 2. Followers (people who follow me)
    // - If I am following_id, the follower is follower_id

    const query = `
      SELECT connected_user_id AS user_id FROM connections WHERE user_id = $1
      UNION
      SELECT user_id FROM connections WHERE connected_user_id = $1
      UNION
      SELECT follower_id AS user_id FROM followers WHERE following_id = $1
    `;

    const { rows } = await pool.query(query, [userId]);
    return rows.map((r) => r.user_id);
  } catch (err) {
    console.error("Error fetching related users for status update:", err);
    return [];
  }
}

module.exports.handleConnection = async (socket) => {
  const userId = socket.userId;
  const relatedUserIds = await getRelatedUsers(userId);

  // Notify friends that I am online
  socketService.broadcastStatus(userId, "online", relatedUserIds);
};

module.exports.handleDisconnect = async (socket) => {
  const userId = socket.userId;
  const relatedUserIds = await getRelatedUsers(userId);

  // Notify friends that I am offline
  socketService.broadcastStatus(userId, "offline", relatedUserIds);
};
