
module.exports.getUserRoom = (userId) => `user_${userId}`;
module.exports.getConversationRoom = (conversationId) => `conversation_${conversationId}`;
module.exports.getStoryRoom = (storyId) => `story_${storyId}`;
module.exports.getOrgRoom = (orgId) => `org_${orgId}`;
module.exports.getCompanyRoom = module.exports.getOrgRoom; // Legacy alias
module.exports.getPostRoom = (postId) => `post_${postId}`;
