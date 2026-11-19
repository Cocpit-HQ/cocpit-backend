const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const { getOrganizationMembership } = require("../../core/middlewares/actor-context.middleware");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { r2Client, hasR2, bucketName, extractR2Key } = require("../../core/infrastructure/r2.client");
const { isOriginAllowed } = require("../../core/security/cors.security");

// Strict Unicode Emoji validation pattern (supports emoji presentation, variation selectors, modifiers, and ZWJ sequences)
const EMOJI_REGEX = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\uFE0E|\p{Emoji_Modifier})*(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\uFE0E|\p{Emoji_Modifier})*)*$/u;

/**
 * Asserts that the given user is an active participant of the specified conversation.
 * Handles both personal DMs and groups.
 * @param {string} conversationId 
 * @param {string} userId 
 * @param {object} [queryable=pool] Optional db client (e.g. within active transaction)
 * @returns {Promise<object>} Active participant record
 */
async function assertConversationParticipant(conversationId, userId, queryable = pool) {
    if (!conversationId || !userId) {
        throw new AppError("conversationId and userId are required", 400);
    }

    const res = await queryable.query(
        `SELECT participant_id, conversation_id, user_id, org_id, role, left_at
         FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         LIMIT 1`,
        [conversationId, userId]
    );

    if (res.rowCount === 0) {
        throw new AppError("Forbidden: You are not an active participant in this conversation", 403);
    }

    return res.rows[0];
}

/**
 * Asserts that the given user is the authorized recipient of a pending chat request.
 * Prevents third-party forced acceptance or unilateral conversation shutdown (VULN-10).
 * @param {string} conversationId 
 * @param {string} userId 
 * @param {object} [queryable=pool] Optional db client
 * @returns {Promise<object>} Object containing conversation and participant details
 */
async function assertChatRequestRecipient(conversationId, userId, queryable = pool) {
    if (!conversationId || !userId) {
        throw new AppError("conversationId and userId are required", 400);
    }

    // 1. Fetch conversation details
    const convRes = await queryable.query(
        `SELECT conversation_id, is_active, is_requesting, created_by, is_group
         FROM conversations
         WHERE conversation_id = $1`,
        [conversationId]
    );

    if (convRes.rowCount === 0) {
        throw new AppError("Conversation not found", 404);
    }

    const conversation = convRes.rows[0];

    // 2. Verify caller is an active participant in the conversation
    const partRes = await queryable.query(
        `SELECT participant_id, user_id, org_id, left_at
         FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         LIMIT 1`,
        [conversationId, userId]
    );

    if (partRes.rowCount === 0) {
        throw new AppError("Forbidden: You are not an active participant in this conversation", 403);
    }

    // 3. Verify requesting state
    if (!conversation.is_requesting) {
        throw new AppError("Invalid request: Conversation is not in pending request state", 400);
    }

    // 4. Verify caller is NOT the initiator (only the recipient can accept or decline)
    if (String(conversation.created_by) === String(userId)) {
        throw new AppError("Invalid request: Only the recipient can accept or decline a chat request", 400);
    }

    return {
        conversation,
        participant: partRes.rows[0],
    };
}

/**
 * Asserts that the caller is an active member of the requested organization (CHAT-001, CHAT-002, VULN-12, VULN-15).
 * @param {string} orgId 
 * @param {string} userId 
 * @param {object} [queryable=pool] Optional db client
 * @returns {Promise<object>} Active organization membership record
 */
async function assertOrgMembership(orgId, userId, queryable = pool) {
    if (!orgId) return null;
    if (!userId) {
        throw new AppError("Authentication required", 401);
    }

    const membership = await getOrganizationMembership(orgId, userId, queryable);

    if (!membership || membership.status !== "ACTIVE" || membership.is_deactivated || membership.is_deleted || membership.is_suspended) {
        throw new AppError("Forbidden: You are not an active member of this organization", 403);
    }

    return membership;
}

/**
 * Asserts that the caller is an active member of the private group (VULN-06, VULN-11).
 * @param {string} groupId 
 * @param {string} userId 
 * @param {object} [queryable=pool] Optional db client
 * @returns {Promise<object>} Group participant record
 */
async function assertGroupMember(groupId, userId, queryable = pool) {
    if (!groupId || !userId) {
        throw new AppError("groupId and userId are required", 400);
    }

    const res = await queryable.query(
        `SELECT participant_id, conversation_id, user_id, role, left_at
         FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         LIMIT 1`,
        [groupId, userId]
    );

    if (res.rowCount === 0) {
        throw new AppError("Forbidden: You are not an active member of this group", 403);
    }

    return res.rows[0];
}

/**
 * Sanitizes and validates a message reaction emoji (VULN-05).
 * Allows empty string for clearing a reaction.
 * Rejects non-emojis and strings exceeding 8 characters.
 * @param {any} emoji 
 * @returns {string} Trimmed emoji string or empty string
 */
function sanitizeReactionEmoji(emoji) {
    if (typeof emoji !== "string") {
        return "";
    }
    const trimmed = emoji.trim();
    if (trimmed === "") {
        return "";
    }

    if (trimmed.length > 8 || !EMOJI_REGEX.test(trimmed)) {
        throw new AppError("Invalid emoji. Must be a valid emoji character up to 8 characters", 400);
    }

    return trimmed;
}

/**
 * Validates text content length for editing / sending messages (VULN-17).
 * @param {string} text 
 * @param {number} [maxLength=5000]
 * @returns {string} Trimmed text content
 */
function validateMessageContent(text, maxLength = 5000) {
    if (typeof text !== "string") {
        throw new AppError("Message content must be text", 400);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        throw new AppError("Message content cannot be empty", 400);
    }
    if (trimmed.length > maxLength) {
        throw new AppError(`Message content exceeds maximum allowed length of ${maxLength} characters`, 400);
    }
    return trimmed;
}

/**
 * Generates an S3/R2 presigned GET URL for secure temporary download (CHAT-003).
 * @param {string} keyOrUrl - S3 key or legacy URL
 * @param {number} [expiresIn=900] - Expiration in seconds (default 15m)
 * @returns {Promise<string>} Temporary signed URL
 */
async function generatePresignedDownloadUrl(keyOrUrl, expiresIn = 900) {
    if (!hasR2 || !r2Client || !keyOrUrl) return keyOrUrl;
    const key = extractR2Key(keyOrUrl);
    if (!key) return keyOrUrl;

    try {
        const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
        return await getSignedUrl(r2Client, command, { expiresIn });
    } catch (err) {
        console.error("[chatSecurity] generatePresignedDownloadUrl error:", err.message);
        return keyOrUrl;
    }
}

/**
 * Inspects a file buffer's magic bytes to prevent MIME spoofing and XSS payloads (VULN-07).
 * Rejects HTML, JS scripts, and files whose byte headers contradict their declared MIME type.
 * @param {Buffer} buffer - File buffer
 * @param {string} declaredMimeType - MIME type sent in request header
 * @returns {{ verified: boolean, detectedExt: string }}
 */
function validateFileMagicBytes(buffer, declaredMimeType) {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new AppError("Invalid or empty file buffer", 400);
    }

    const mime = (declaredMimeType || "").toLowerCase().trim();

    // Check for obvious text/HTML/script injection disguised as image/media
    const headerString = buffer.slice(0, 100).toString("ascii").toLowerCase();
    if (
        headerString.includes("<html") ||
        headerString.includes("<!doctype html") ||
        headerString.includes("<script") ||
        headerString.includes("<?php")
    ) {
        throw new AppError("Malicious file content detected: Script or HTML payload rejected", 400);
    }

    // Magic byte signatures:
    // JPEG: FF D8 FF
    const isJpeg = buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    const isPng = buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
    // WEBP: RIFF (bytes 0-3) ... WEBP (bytes 8-11)
    const isWebp = buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP";
    // GIF: GIF87a or GIF89a
    const isGif = buffer.length >= 6 && buffer.toString("ascii", 0, 4) === "GIF8";
    // PDF: %PDF (25 50 44 46)
    const isPdf = buffer.length >= 4 &&
        buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
    // MP4/MOV: bytes 4-8 equal 'ftyp' or 'moov'
    const isMp4 = buffer.length >= 8 &&
        (buffer.toString("ascii", 4, 8) === "ftyp" || buffer.toString("ascii", 4, 8) === "moov");
    // ZIP based (DOCX): 50 4B 03 04
    const isZip = buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    // Legacy MS DOC: D0 CF 11 E0
    const isOleDoc = buffer.length >= 4 &&
        buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;

    let detectedExt = "";

    if (mime.includes("jpeg") || mime.includes("jpg")) {
        if (!isJpeg) throw new AppError("Invalid JPEG: file signature does not match JPEG format", 400);
        detectedExt = ".jpg";
    } else if (mime.includes("png")) {
        if (!isPng) throw new AppError("Invalid PNG: file signature does not match PNG format", 400);
        detectedExt = ".png";
    } else if (mime.includes("webp")) {
        if (!isWebp) throw new AppError("Invalid WEBP: file signature does not match WEBP format", 400);
        detectedExt = ".webp";
    } else if (mime.includes("gif")) {
        if (!isGif) throw new AppError("Invalid GIF: file signature does not match GIF format", 400);
        detectedExt = ".gif";
    } else if (mime.includes("pdf")) {
        if (!isPdf) throw new AppError("Invalid PDF: file signature does not match PDF format", 400);
        detectedExt = ".pdf";
    } else if (mime.includes("mp4") || mime.includes("video/quicktime") || mime.includes("mov")) {
        if (!isMp4) throw new AppError("Invalid Video: file signature does not match MP4/MOV format", 400);
        detectedExt = ".mp4";
    } else if (mime.includes("wordprocessingml") || mime.includes("docx")) {
        if (!isZip) throw new AppError("Invalid DOCX: file signature does not match DOCX format", 400);
        detectedExt = ".docx";
    } else if (mime.includes("msword")) {
        if (!isOleDoc && !isZip) throw new AppError("Invalid DOC: file signature does not match DOC format", 400);
        detectedExt = ".doc";
    } else {
        throw new AppError(`Unsupported or unverified file type: ${declaredMimeType}`, 400);
    }

    return { verified: true, detectedExt };
}



// ─────────────────────────────────────────────────────────────────────────────
// Express Middleware Wrappers
// ─────────────────────────────────────────────────────────────────────────────

const requireChatRequestRecipientMiddleware = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.user_id;
        const { conversationId } = req.params;
        const authData = await assertChatRequestRecipient(conversationId, userId, pool);
        req.chatAuth = authData;
        next();
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

const requireConversationParticipantMiddleware = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.user_id;
        const conversationId = req.params.conversationId || req.params.id;
        const participant = await assertConversationParticipant(conversationId, userId, pool);
        req.chatParticipant = participant;
        next();
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

const requireGroupMemberMiddleware = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.user_id;
        const groupId = req.params.groupId || req.params.id;
        const member = await assertGroupMember(groupId, userId, pool);
        req.groupMember = member;
        next();
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

module.exports = {
    // Core Assertions (use in controllers, services, socket handlers)
    assertConversationParticipant,
    assertChatRequestRecipient,
    assertOrgMembership,
    assertGroupMember,
    sanitizeReactionEmoji,
    validateMessageContent,
    generatePresignedDownloadUrl,
    validateFileMagicBytes,
    isOriginAllowed,

    // Optional Express Middlewares (use in routes)
    requireChatRequestRecipientMiddleware,
    requireConversationParticipantMiddleware,
    requireGroupMemberMiddleware,
};
