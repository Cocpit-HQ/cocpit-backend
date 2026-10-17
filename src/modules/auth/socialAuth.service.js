const { verifyGoogleToken } = require('./googleAuth.service');
const { verifyAppleToken } = require('./appleAuth.service');

/**
 * A centralized service to verify social tokens.
 * This simplifies the auth controller and service logic.
 *
 * @param {string} provider - The social provider ('google' or 'apple').
 * @param {string} idToken - The JWT received from the provider's SDK.
 * @param {string} [nonce] - Optional cryptographic nonce for replay protection (used by Apple).
 * @returns {Object} An object containing at minimum: { socialId, email, fullName, avatarUrl }
 */
const verifySocialToken = async (provider, idToken, nonce) => {
    switch (provider) {
        case 'google': {
            const payload = await verifyGoogleToken(idToken);
            return {
                providerId: payload.googleId,
                email: payload.email,
                fullName: payload.fullName,
                // SCRUM-998: Do not use Google profile picture automatically in Cocpit
                avatarUrl: null
            };
        }
        case 'apple': {
            const payload = await verifyAppleToken(idToken, nonce);
            return {
                providerId: payload.appleId,
                email: payload.email,
                // Apple only sends name on the first login via frontend SDK,
                // so these will be handled at the controller/service level.
                fullName: null,
                avatarUrl: null
            };
        }
        default:
            throw new Error(`Unsupported social provider: ${provider}`);
    }
};

module.exports = { verifySocialToken };
