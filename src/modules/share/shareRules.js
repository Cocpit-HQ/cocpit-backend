/**
 * Share Rules — Centralized validation for share business rules
 *
 * Rules:
 *   1. USER profiles cannot be shared with COMPANY accounts.
 *   2. COMPANY profiles can be shared with anyone (users and companies).
 *
 * To add new rules, update the validateShareRules function.
 */

const pool = require("../../core/db/pool");

/**
 * Validate a share request against business rules.
 *
 * @param {object} params
 * @param {string} params.senderId      - the ID of the user sending the share
 * @param {string} params.entityType    - "post" | "profile" | "company" | "job" | "event"
 * @param {string} params.entityId      - the ID of the entity being shared
 * @param {string} params.receiverType  - "user" | "company"
 * @param {string} params.senderOrgId   - the ID of the organization if sender is acting as a company
 * @throws {{ status: number, message: string }} if a rule is violated
 */
async function validateShareRules({ senderId, entityType, entityId, receiverType, senderOrgId }) {
    // 1. New Global Rule: Users cannot share ANY content with Company accounts.
    // Companies (senderOrgId exists) can share with anyone.
    if (!senderOrgId && receiverType === "company") {
        throw { status: 400, message: "Users cannot share content with company accounts." };
    }

    // 2. Specific Rule: Only USER profiles are blocked from being shared with companies.
    // (This might be redundant now if ALL users are blocked from sharing with companies,
    // but what if a company tries to share a USER profile with a company? The old rule 
    // blocked that. Let's keep the entity-specific check for completeness).
    if (entityType === "profile" && receiverType === "company") {
        // Look up the profile owner's account type
        const result = await pool.query(
            `SELECT account_type FROM profiles WHERE user_id = $1`,
            [entityId]
        );
        const ownerType = result.rows[0]?.account_type;

        // Block only if the profile owner is a regular user
        if (!ownerType || ownerType === "user") {
            throw { status: 400, message: "User profiles cannot be shared with company accounts." };
        }
        // If ownerType is "company", allow the share
    }
}

module.exports = { validateShareRules };
