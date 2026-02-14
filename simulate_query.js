require('dotenv').config();
const pool = require('./src/db/pool');

async function simulateGetConversations() {
    const userId = '3606d096-be60-4ce7-948c-e5eef42cbbd2'; // Ankita
    try {
        const query = `
SELECT 
    c.*,
    -- Block Status
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.user_id) END as is_blocked_by_me,
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) END as is_blocked_by_other,

    -- Name logic: Use group name if group, else other user's name
    CASE 
        WHEN c.is_group THEN c.conversation_name 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN 'User not found'
        ELSE u.full_name 
    END AS other_user_name,
    
    -- Avatar logic: Use group avatar if group, else other user's avatar
    CASE 
        WHEN c.is_group THEN c.group_avatar 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN NULL
        ELSE u.avatar_url 
    END AS other_user_avatar,
    
    -- Other user ID (only for 1-on-1)
    u.user_id AS other_user_id,
    u.headline AS other_user_headline,
    
    cp.is_active,

    -- Get the most recent message dynamically
    COALESCE(m.text_content, c.last_message) AS last_message_text,
    COALESCE(m.created_at, c.last_message_at, c.updated_at) AS last_message_at
FROM conversations c
JOIN (
    -- Aggregate participation: Ensure one row per conversation for this user
    -- and check if they have any active record
    SELECT conversation_id, user_id,
           EXISTS(SELECT 1 FROM conversation_participants cp_a 
                  WHERE cp_a.conversation_id = cp_main.conversation_id 
                  AND cp_a.user_id = cp_main.user_id 
                  AND cp_a.left_at IS NULL) as is_active
    FROM conversation_participants cp_main
    WHERE cp_main.user_id = $1
    GROUP BY conversation_id, user_id
) cp ON c.conversation_id = cp.conversation_id
-- For 1-on-1, join the other participant.
LEFT JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
    AND cp_other.user_id != $1 AND c.is_group = FALSE
LEFT JOIN users u ON cp_other.user_id = u.user_id

-- LATERAL JOIN to find the latest VISIBLE message across ANY period
LEFT JOIN LATERAL (
    SELECT 
        CASE 
            WHEN msg.is_deleted_for_everyone THEN 'This message was deleted'
            WHEN msg.shared_post_id IS NOT NULL THEN 'Shared a post'
            WHEN msg.text_content IS NULL OR msg.text_content = '' THEN 'Attachment'
            ELSE msg.text_content
        END as text_content,
        msg.created_at
    FROM messages msg
    JOIN conversation_participants cp_msg ON cp_msg.conversation_id = msg.conversation_id AND cp_msg.user_id = $1
    WHERE msg.conversation_id = c.conversation_id
    AND msg.created_at >= cp_msg.joined_at
    AND (cp_msg.left_at IS NULL OR msg.created_at <= cp_msg.left_at)
    -- Exclude messages deleted for me
    AND NOT EXISTS (
        SELECT 1 FROM message_delete md 
        WHERE md.message_id = msg.message_id 
        AND md.user_id = $1
    )
    ORDER BY msg.created_at DESC 
    LIMIT 1
) m ON true

ORDER BY COALESCE(m.created_at, c.last_message_at, c.updated_at) DESC NULLS LAST;
    `;

        const res = await pool.query(query, [userId]);
        console.log(`Conversations result for Ankita:`);
        console.log(JSON.stringify(res.rows, null, 2));

    } catch (err) {
        console.error("Simulation failed:", err);
    } finally {
        await pool.end();
    }
}

simulateGetConversations();
