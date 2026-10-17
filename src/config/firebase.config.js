/**
 * Firebase Admin Configuration
 * Initializes the SDK using the service account path defined in .env.
 */
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

if (!serviceAccountPath) {
    console.warn("⚠️ Firebase Admin: FIREBASE_SERVICE_ACCOUNT_PATH not set in .env. Push notifications will be disabled.");
} else {
    // Resolve path relative to project root if it's not absolute
    const absolutePath = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.join(process.cwd(), serviceAccountPath);

    if (!fs.existsSync(absolutePath)) {
        console.warn(`⚠️ Firebase Admin: Service account file not found at ${absolutePath}. Push notifications will be disabled.`);
    } else {
        try {
            const serviceAccount = require(absolutePath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log("✅ Firebase Admin initialized successfully");
        } catch (err) {
            console.error("❌ Firebase Admin initialization failed:", err.message);
        }
    }
}

module.exports = admin;
