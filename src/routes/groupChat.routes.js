const express = require("express");
const router = express.Router();
const controller = require("../controllers/groupChat.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const groupAdminMiddleware = require("../middlewares/groupAdmin.middleware");

// Apply auth middleware to all routes
router.use(authMiddleware.requireAuth);

router.post("/groups", controller.createGroup);
router.get("/groups/invitations", controller.getPendingInvitations);
router.post("/groups/invitation/respond", controller.respondInvitation);

// Admin-only routes
router.post("/groups/:groupId/invite", groupAdminMiddleware.requireGroupAdmin, controller.inviteMember);
router.post("/groups/invite", groupAdminMiddleware.requireGroupAdmin, controller.inviteMember); // Keep legacy if needed
router.get("/groups/:groupId/invitations", groupAdminMiddleware.requireGroupAdmin, controller.getGroupInvitations);
router.delete("/groups/:groupId/members/:userId", groupAdminMiddleware.requireGroupAdmin, controller.removeMember);
router.post("/groups/:groupId/members/:userId/promote", groupAdminMiddleware.requireGroupAdmin, controller.promoteToAdmin);
router.post("/groups/:groupId/members/:userId/demote", groupAdminMiddleware.requireGroupAdmin, controller.demoteAdmin);
router.put("/groups/:groupId/avatar", groupAdminMiddleware.requireGroupAdmin, controller.updateGroupAvatar);
router.patch("/groups/:groupId/role", groupAdminMiddleware.requireGroupAdmin, controller.updateMemberRole);

router.get("/groups/:groupId", controller.getGroupDetails);
router.delete("/groups/:groupId", controller.deleteGroup);
router.post("/groups/:groupId/leave", controller.leaveGroup);
router.post("/groups/:groupId/messages", require("../middlewares/upload").uploadChatMedia.fields([
    { name: 'images', maxCount: 10 },
    { name: 'videos', maxCount: 5 },
    { name: 'documents', maxCount: 5 }
]), controller.sendMessage);

// Read Receipts
router.post("/groups/:groupId/read", controller.markGroupMessagesAsRead);
router.get("/groups/:groupId/messages/:messageId/read", controller.getMessageReadReceipts);

module.exports = router;
