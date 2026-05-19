const pool = require("../core/db/pool");

const buildMuteState = (row) => {
  if (!row) return null;

  const mutedUntil = row.muted_until ? new Date(row.muted_until) : null;
  const muteActive =
    !!row.is_muted && (!mutedUntil || mutedUntil.getTime() > Date.now());

  return {
    conversationId: row.conversation_id,
    participantId: row.participant_id,
    userId: row.user_id,
    companyId: row.org_id,
    isMuted: muteActive,
    mutedUntil: row.muted_until,
    muteUpdatedAt: row.mute_updated_at,
  };
};

const getConversationMuteState = async (
  executor,
  { conversationId, userId, companyId = null }
) => {
  const db = executor || pool;
  const result = await db.query(
    `
      SELECT
        participant_id,
        conversation_id,
        user_id,
        org_id,
        is_muted,
        muted_until,
        mute_updated_at
      FROM conversation_participants
      WHERE conversation_id = $1
      AND left_at IS NULL
      AND (
        ($3::uuid IS NOT NULL AND org_id = $3)
        OR
        ($3::uuid IS NULL AND user_id = $2)
      )
      ORDER BY joined_at DESC
      LIMIT 1
    `,
    [conversationId, userId, companyId]
  );

  return buildMuteState(result.rows[0] || null);
};

const listConversationMuteStates = async (executor, conversationId) => {
  const db = executor || pool;
  const result = await db.query(
    `
      SELECT
        participant_id,
        conversation_id,
        user_id,
        org_id,
        is_muted,
        muted_until,
        mute_updated_at
      FROM conversation_participants
      WHERE conversation_id = $1
      AND left_at IS NULL
    `,
    [conversationId]
  );

  return result.rows.map(buildMuteState);
};

const updateConversationMuteState = async (
  executor,
  { conversationId, userId, companyId = null, muted, mutedUntil = null }
) => {
  const db = executor || pool;
  const result = await db.query(
    `
      UPDATE conversation_participants
      SET
        is_muted = $4,
        muted_until = CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,
        mute_updated_at = NOW()
      WHERE conversation_id = $1
      AND left_at IS NULL
      AND (
        ($3::uuid IS NOT NULL AND org_id = $3)
        OR
        ($3::uuid IS NULL AND user_id = $2)
      )
      RETURNING
        participant_id,
        conversation_id,
        user_id,
        org_id,
        is_muted,
        muted_until,
        mute_updated_at
    `,
    [conversationId, userId, companyId, muted, mutedUntil]
  );

  return buildMuteState(result.rows[0] || null);
};

module.exports = {
  getConversationMuteState,
  listConversationMuteStates,
  updateConversationMuteState,
};
