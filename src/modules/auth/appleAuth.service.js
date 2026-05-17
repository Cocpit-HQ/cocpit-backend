/**
 * Apple Auth Service
 * Handles verification of Apple ID tokens using apple-signin-auth.
 * This ensures the token is valid, not expired, and issued for this app's bundle ID.
 */
const appleSigninAuth = require('apple-signin-auth');

/**
 * Verifies an Apple ID token and extracts the user payload.
 *
 * Security decisions:
 * - `audience` is checked against APPLE_CLIENT_ID (the iOS Bundle ID).
 * - `nonce` verification is optional but highly recommended to prevent replay attacks.
 *
 * @param {string} idToken - The ID token from the Apple frontend SDK.
 * @param {string} [nonce] - Optional cryptographic nonce to verify against the token.
 * @returns {Object} Verified Apple user payload.
 * @throws {Error} If verification fails.
 */
const verifyAppleToken = async (idToken, nonce) => {
    try {
        const verifyOptions = {
            audience: process.env.APPLE_CLIENT_ID,
            ignoreExpiration: false,
        };

        if (nonce) {
            verifyOptions.nonce = nonce;
        }

        const payload = await appleSigninAuth.verifyIdToken(idToken, verifyOptions);

        // Apple treats email_verified as a string "true" or a boolean true
        const isEmailVerified = payload.email_verified === 'true' || payload.email_verified === true;

        if (!isEmailVerified && payload.email) {
            throw new Error("Apple email is not verified");
        }

        return {
            appleId: payload.sub,       // Stable, unique Apple account identifier
            email: payload.email,         // User's primary email (or private relay email)
        };
    } catch (err) {
        throw new Error(`Apple token verification failed: ${err.message}`);
    }
};

module.exports = { verifyAppleToken };
