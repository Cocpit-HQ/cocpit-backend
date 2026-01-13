const pool = require("../db/pool");
// const pool = require("../config/db");
const SocketService = require("../services/socket.service");

/**
 * Fetch followers + following users for presence updates
 */
async function getRelatedUserIds(userId) {
  const followersRes = await pool.query(
    `SELECT follower_id FROM followers WHERE following_id = $1`,
    [userId]
  );

  const followingRes = await pool.query(
    `SELECT following_id FROM followers WHERE follower_id = $1`,
    [userId]
  );

  const ids = new Set();

  followersRes.rows.forEach(r => ids.add(r.follower_id));
  followingRes.rows.forEach(r => ids.add(r.following_id));

  return [...ids];
}

/**
 * User comes online
 */
module.exports.handleConnection = async (socket) => {
  try {
    const recipientIds = await getRelatedUserIds(socket.userId);

    console.log("🟢 STATUS ONLINE:", {
      userId: socket.userId,
      recipients: recipientIds,
    });

    SocketService.broadcastStatus(
      socket.userId,
      "online",
      recipientIds
    );
  } catch (err) {
    console.error("Status connect error:", err);
  }
};

/**
 * User goes offline
 */
module.exports.handleDisconnect = async (socket) => {
  try {
    const recipientIds = await getRelatedUserIds(socket.userId);

    console.log("🔴 STATUS OFFLINE:", {
      userId: socket.userId,
      recipients: recipientIds,
    });

    SocketService.broadcastStatus(
      socket.userId,
      "offline",
      recipientIds
    );
  } catch (err) {
    console.error("Status disconnect error:", err);
  }
};
