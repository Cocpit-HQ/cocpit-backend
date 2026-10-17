/**
 * seed_achievement_images.js
 * 
 * One-time script to upload predefined achievement PNGs to Cloudinary
 * and insert records into the achievement_images table.
 * 
 * IDEMPOTENT: Safe to run multiple times. Skips images that already exist
 * in the database (matched by `key`).
 * 
 * Usage: node src/scripts/seed_achievement_images.js
 */

require("dotenv").config();
const pool = require("../core/db/pool");
const cloudinary = require("../core/infrastructure/cloudinary.client");
const path = require("path");
const fs = require("fs");

// ─── Image definitions ───────────────────────────────────────────────────────
// Maps filename (without extension) to display metadata.
// display_order controls the order images appear in the picker UI.
const ACHIEVEMENT_IMAGES = [
    { filename: "celebration.png",     key: "celebration",     title: "Celebration",       display_order: 1 },
    { filename: "celebration1.png",    key: "celebration1",    title: "Celebration",       display_order: 2 },
    { filename: "certification.png",   key: "certification",   title: "Certification",     display_order: 3 },
    { filename: "graduationhat.png",   key: "graduationhat",   title: "Graduation Hat",    display_order: 4 },
    { filename: "helpingpartner.png",  key: "helpingpartner",  title: "Helping Partner",   display_order: 5 },
    { filename: "newmemeber.png",      key: "newmemeber",      title: "New Member",        display_order: 6 },
    { filename: "newteammemeber.png",  key: "newteammemeber",  title: "New Team Member",   display_order: 7 },
    { filename: "workanniversary.png", key: "workanniversary", title: "Work Anniversary",  display_order: 8 },
];

// Path to the local achievement images directory
const IMAGES_DIR = path.resolve(__dirname, "../../../cocpit-frontend/public/images/achievement");

const seedAchievementImages = async () => {
    console.log("🚀 Starting achievement image seed...");
    console.log(`📁 Images directory: ${IMAGES_DIR}`);

    // Verify directory exists
    if (!fs.existsSync(IMAGES_DIR)) {
        console.error(`❌ Images directory not found: ${IMAGES_DIR}`);
        process.exit(1);
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const img of ACHIEVEMENT_IMAGES) {
        const filePath = path.join(IMAGES_DIR, img.filename);

        // Check if file exists on disk
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️  File not found, skipping: ${img.filename}`);
            failed++;
            continue;
        }

        // Check if already exists in database (idempotency)
        const existingCheck = await pool.query(
            `SELECT id, cloudinary_url FROM achievement_images WHERE key = $1`,
            [img.key]
        );

        if (existingCheck.rowCount > 0) {
            console.log(`⏭️  Already exists: ${img.key} (id=${existingCheck.rows[0].id})`);
            skipped++;
            continue;
        }

        // Upload to Cloudinary
        console.log(`📤 Uploading: ${img.filename}...`);
        try {
            const uploadResult = await cloudinary.uploader.upload(filePath, {
                folder: "achievement_images",
                public_id: `achievement_${img.key}`,
                resource_type: "image",
                overwrite: false, // Don't overwrite if already exists in Cloudinary
            });

            const cloudinaryUrl = uploadResult.secure_url;
            console.log(`   ✅ Uploaded: ${cloudinaryUrl}`);

            // Insert into database
            const insertResult = await pool.query(
                `INSERT INTO achievement_images (key, title, cloudinary_url, display_order, is_active)
                 VALUES ($1, $2, $3, $4, TRUE)
                 ON CONFLICT (key) DO NOTHING
                 RETURNING id`,
                [img.key, img.title, cloudinaryUrl, img.display_order]
            );

            if (insertResult.rowCount > 0) {
                console.log(`   📝 Inserted: id=${insertResult.rows[0].id}, key=${img.key}`);
                uploaded++;
            } else {
                console.log(`   ⏭️  Already in DB (race condition safe): ${img.key}`);
                skipped++;
            }
        } catch (err) {
            console.error(`   ❌ Failed to upload ${img.filename}:`, err.message);
            failed++;
        }
    }

    console.log("\n─────────────────────────────────────────");
    console.log(`✅ Uploaded: ${uploaded}`);
    console.log(`⏭️  Skipped:  ${skipped}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log("─────────────────────────────────────────");

    // Print final table state
    const { rows } = await pool.query(
        `SELECT id, key, title, cloudinary_url, display_order FROM achievement_images ORDER BY display_order`
    );
    console.log("\n📋 Current achievement_images table:");
    console.table(rows);

    process.exit(0);
};

seedAchievementImages().catch(err => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
});
