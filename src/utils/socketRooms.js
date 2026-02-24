
module.exports.getUserRoom = (userId) => `user_${userId}`;
module.exports.getConversationRoom = (conversationId) => `conversation_${conversationId}`;
module.exports.getStoryRoom = (storyId) => `story_${storyId}`;
