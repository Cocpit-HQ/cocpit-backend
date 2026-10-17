/**
 * Firebase Admin Configuration
 * Credentials, first match wins:
 *   1. FIREBASE_SERVICE_ACCOUNT_BASE64 — base64 of the service-account JSON (Railway / containers)
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH   — path to the JSON file (local dev / PM2)
 */
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

function loadServiceAccount() {
    const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (base64 && base64.trim()) {
        return JSON.parse(Buffer.from(base64.trim(), "base64").toString("utf8"));
    }

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!serviceAccountPath) {
        console.warn("⚠️ Firebase Admin: neither FIREBASE_SERVICE_ACCOUNT_BASE64 nor FIREBASE_SERVICE_ACCOUNT_PATH is set. Push notifications will be disabled.");
        return null;
    }

    // Resolve path relative to project root if it's not absolute
    const absolutePath = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.join(process.cwd(), serviceAccountPath);

    if (!fs.existsSync(absolutePath)) {
        console.warn(`⚠️ Firebase Admin: Service account file not found at ${absolutePath}. Push notifications will be disabled.`);
        return null;
    }
    return require(absolutePath);
}

try {
    const serviceAccount = loadServiceAccount();
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        console.log("✅ Firebase Admin initialized successfully");
    }
} catch (err) {
    console.error("❌ Firebase Admin initialization failed:", err.message);
}

module.exports = admin;
