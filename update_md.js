const fs = require('fs');
const path = 'c:/Users/user3/Desktop/cocpit/.agents/notification-plan/Backend_Changes_For_Mobile.md';
let content = fs.readFileSync(path, 'utf8');

const socketContent = `
### [NEW] Community Invitation Sent
Triggered when a user is invited to join a community.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "type": "community_invite",
  "title": "You're invited to join a channel",
  "message": "{Inviter Name} invited you to join \\"{Channel Name}\\"",
  "timestamp": "2023-10-25T14:30:00Z"
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.

### [NEW] Community Invitation Accepted
Triggered when a user accepts an invitation to join a community. Sent to the original inviter.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "type": "community_invite_accepted",
  "title": "Invitation accepted",
  "message": "{Name} accepted your invite to \\"{Community Name}\\"",
  "timestamp": "2023-10-25T14:30:00Z"
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.

### [NEW] Team Invitation Sent
Triggered when a user is invited to join a company team.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "type": "organization_invite",
  "title": "You're invited to join a team",
  "message": "{Company Name} invited you to join \\"{Department Name}\\" department",
  "timestamp": "2023-10-25T14:30:00Z"
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.

### [NEW] Team Invitation Accepted
Triggered when a user accepts a team invitation. Sent to the original inviter.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "type": "team_invite_accepted",
  "title": "Invitation",
  "message": "{Invitee Name} accepted your invitation and joined the \\"{Department Name}\\"",
  "timestamp": "2023-10-25T14:30:00Z"
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.

### [NEW] Post Like
Triggered when someone likes a user's post.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "notification_id": "uuid",
  "type": "like",
  "text": "\\"user_name\\" liked your post",
  "reference_id": "uuid-of-post",
  "is_read": false,
  "created_at": "2023-10-25T14:30:00Z",
  "actor_name": "user_name",
  "actor_avatar": "url",
  "metadata": { "post_id": "uuid-of-post" }
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Push notification is only sent when the post hits specific like thresholds (6, 10, 40, etc.).

### [NEW] Post Comment
Triggered when someone comments on a user's post.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "notification_id": "uuid",
  "type": "comment",
  "text": "Name commented: \\"{comment preview, 40 chars}\\"",
  "reference_id": "uuid-of-post",
  "is_read": false,
  "created_at": "2023-10-25T14:30:00Z",
  "actor_name": "Name",
  "actor_avatar": "url",
  "metadata": { "post_id": "uuid-of-post", "comment_id": "uuid" }
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Push notification is only sent when the post hits specific comment thresholds (40, 55, 70, etc.).

### [NEW] User Mention
Triggered when someone mentions a user in a post or comment.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "notification_id": "uuid",
  "type": "mention",
  "text": "{user_name} mentioned you in a post/comment.",
  "reference_id": "uuid-of-post",
  "is_read": false,
  "created_at": "2023-10-25T14:30:00Z",
  "actor_name": "{user_name}",
  "actor_avatar": "url",
  "metadata": { "post_id": "uuid-of-post" }
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.

### [NEW] Post Share
Triggered when someone shares a user's post.
*   **Socket Channel:** \`notification\`
*   **Payload structure:**
\`\`\`json
{
  "notification_id": "uuid",
  "type": "share",
  "text": "\\"{user_name}\\" shared your post with their network",
  "reference_id": "uuid-of-post",
  "is_read": false,
  "created_at": "2023-10-25T14:30:00Z",
  "actor_name": "{user_name}",
  "actor_avatar": "url",
  "metadata": { "post_id": "uuid-of-post" }
}
\`\`\`
*   **Action for Mobile:** Display in notification center. **Note:** Accompanied by a push notification.
`;

const pushContent = `
### [NEW] Connections & Invitations
*   **Community Invitation Sent:** Title: \`You're invited to join a channel\`, Body: \`{Inviter Name} invited you to join "{Channel Name}"\`, Data Payload: \`{"type": "community_invite"}\`
*   **Community Invitation Accepted:** Title: \`Invitation accepted\`, Body: \`{Name} accepted your invite to "{Community Name}"\`, Data Payload: \`{"type": "community_invite_accepted"}\`
*   **Team Invitation Sent:** Title: \`You're invited to join a team\`, Body: \`{Company Name} invited you to join "{Department Name}" department\`, Data Payload: \`{"type": "organization_invite"}\`
*   **Team Invitation Accepted:** Title: \`Invitation\`, Body: \`{Invitee Name} accepted your invitation and joined the "{Department Name}"\`, Data Payload: \`{"type": "team_invite_accepted"}\`

### [NEW] Posts & Feed
*   **Post Like Threshold:** Triggered only at specific milestones (6, 10, 40, etc.). Title: \`New like on your post\`, Body: \`"{user_name}" liked your post\`, Data Payload: \`{"type": "like", "referenceId": "uuid"}\`
*   **Post Comment Threshold:** Triggered only at specific milestones (40, 55, 70, etc.). Title: \`New comment on your post\`, Body: \`{Name} commented: "{comment preview}"\`, Data Payload: \`{"type": "comment", "referenceId": "uuid"}\`
*   **User Mention:** Title: \`You were mentioned\`, Body: \`{user_name} mentioned you in a post/comment.\`, Data Payload: \`{"type": "mention", "referenceId": "uuid"}\`
*   **Post Share:** Title: \`Your post was shared\`, Body: \`"{user_name}" shared your post with their network\`, Data Payload: \`{"type": "share", "referenceId": "uuid"}\`
`;

content = content.replace('## 2. Push Notifications (FCM)', socketContent + '\n## 2. Push Notifications (FCM)');
content = content.replace('## 3. REST API Changes', pushContent + '\n## 3. REST API Changes');

fs.writeFileSync(path, content, 'utf8');
console.log('File updated successfully.');
