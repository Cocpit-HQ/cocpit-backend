/**
 * Google Auth Service
 * Handles verification of Google ID tokens using google-auth-library.
 * This is the ONLY place where Google tokens are verified — never trust frontend claims.
 */
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verifies a Google ID token and extracts the user payload.
 *
 * Security decisions:
 * - `audience` is set to GOOGLE_CLIENT_ID to ensure the token was issued for THIS app.
 *   Without this, an attacker could reuse a token issued for a different app.
 * - `email_verified` is checked to prevent account creation with unverified emails,
 *   which could lead to account takeover if the email is later claimed by the real owner.
 *
 * @param {string} idToken - The ID token from the Google frontend SDK.
 * @returns {Object} Verified Google user payload.
 * @throws {Error} If verification fails for any reason (expired, invalid aud, tampered).
 */
const verifyGoogleToken = async (idToken) => {
    const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    // Reject unverified emails — critical to prevent impersonation attacks.
    if (!payload.email_verified) {
        throw new Error("Google email is not verified");
    }

    return {
        googleId: payload.sub,        // Stable, unique Google account identifier
        email: payload.email,          // User's primary email
        fullName: payload.name,        // Display name
        avatarUrl: payload.picture,    // Profile picture URL
    };
};

module.exports = { verifyGoogleToken };
