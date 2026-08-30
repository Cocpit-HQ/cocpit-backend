const pool = require("../core/db/pool");
// const pool = require("../config/db");
const SocketService = require("../core/infrastructure/socket.service");

/**
 * Fetch followers, following, and active conversation participants for presence updates
 */
async function getRelatedUserIds(userId) {
  const query = `
    WITH base_users AS (
      SELECT follower_id AS user_id FROM followers WHERE following_id = $1
      UNION
      SELECT following_id AS user_id FROM followers WHERE follower_id = $1
      UNION
      SELECT DISTINCT cp2.user_id AS user_id
      FROM conversation_participants cp1
      JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
      WHERE cp1.user_id = $1
        AND cp1.left_at IS NULL
        AND cp2.left_at IS NULL
        AND cp2.user_id <> $1
    )
    SELECT u.user_id 
    FROM base_users u
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks b 
      WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
         OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
    )
  `;

  try {
    const res = await pool.query(query, [userId]);
    return res.rows.map(r => r.user_id);
  } catch (err) {
    console.error("Error in getRelatedUserIds query:", err);
    return [];
  }
}

/**
 * User comes online
 */
module.exports.handleConnection = async (socket) => {
  try {
    const recipientIds = await getRelatedUserIds(socket.userId);


    SocketService.broadcastStatus(
      socket.userId,
      "online",
      recipientIds
    );

    // FIX: Send the online status of friends TO the new user
    recipientIds.forEach(friendId => {
      if (SocketService.isUserOnline(friendId)) {
        socket.emit("userStatusChanged", {
          userId: friendId,
          status: "online"
        });
      }
    });
  } catch (err) {
    console.error("Status connect error:", err);
  }
};

/**
 * User goes offline
 */
module.exports.handleDisconnect = async (socket) => {
  try {
    if (SocketService.isUserOnline(socket.userId)) {
      return;
    }

    // Clear all active typing states and timeouts for this user
    SocketService.clearUserTyping(socket.userId);

    const recipientIds = await getRelatedUserIds(socket.userId);


    SocketService.broadcastStatus(
      socket.userId,
      "offline",
      recipientIds
    );
  } catch (err) {
    console.error("Status disconnect error:", err);
  }
};
