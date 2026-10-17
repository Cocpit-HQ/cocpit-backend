/**
 * Decoupled: No-op helper. String/name matching is done dynamically at query time.
 */
async function handleExperienceOrgLink(client, userId, data) {
    // Decoupled: do nothing
}

/**
 * Decoupled: No-op helper. String/name matching is done dynamically at query time.
 */
async function handleEducationOrgLink(client, userId, data) {
    // Decoupled: do nothing
}

/**
 * Decoupled: No-op helper.
 */
async function cleanupPreviousCompanyMemberships(client, userId, prevOrgIds) {
    // Decoupled: do nothing
}

module.exports = {
    handleExperienceOrgLink,
    handleEducationOrgLink,
    cleanupPreviousCompanyMemberships
};
