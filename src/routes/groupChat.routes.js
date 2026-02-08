const express = require("express");
const router = express.Router();
const controller = require("../controllers/groupChat.controller");
const authMiddleware = require("../middlewares/auth.middleware"); // Fixed path

// Apply auth middleware to all routes
router.use(authMiddleware.requireAuth);

router.post("/groups", controller.createGroup);
router.get("/groups/invitations", controller.getPendingInvitations);
router.post("/groups/invite", controller.inviteMember);
router.post("/groups/invitation/respond", controller.respondInvitation);

router.get("/groups/:groupId", controller.getGroupDetails);
router.delete("/groups/:groupId", controller.deleteGroup);
router.post("/groups/:groupId/leave", controller.leaveGroup);
router.post("/groups/:groupId/messages", controller.sendMessage);
router.get("/groups/:groupId/invitations", controller.getGroupInvitations);
router.delete("/groups/:groupId/members/:userId", controller.removeMember);
router.post("/groups/:groupId/members/:userId/promote", controller.promoteToAdmin);
router.put("/groups/:groupId/avatar", controller.updateGroupAvatar);

// Read Receipts
router.post("/groups/:groupId/read", controller.markGroupMessagesAsRead);
router.get("/groups/:groupId/messages/:messageId/read", controller.getMessageReadReceipts);

module.exports = router;
