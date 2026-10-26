/**
 * seed_achievement_images.js
 * 
 * One-time script to upload predefined achievement PNGs to Cloudflare R2
 * and update/insert records into the achievement_images table.
 * 
 * Usage: node src/scripts/seed_achievement_images.js
 */

require("dotenv").config();
const pool = require("../core/db/pool");
const { uploadBufferToR2 } = require("../core/infrastructure/r2.client");
const path = require("path");
const fs = require("fs");

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

const IMAGES_DIR = path.resolve(__dirname, "../../../cocpit-frontend/public/images/achievement");

const seedAchievementImages = async () => {
    console.log("🚀 Starting achievement image seed to Cloudflare R2...");
    console.log(`📁 Images directory: ${IMAGES_DIR}`);

    if (!fs.existsSync(IMAGES_DIR)) {
        console.error(`❌ Directory not found: ${IMAGES_DIR}`);
        process.exit(1);
    }

    let uploaded = 0;
    let failed = 0;

    for (const img of ACHIEVEMENT_IMAGES) {
        const filePath = path.join(IMAGES_DIR, img.filename);
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️  File not found: ${img.filename}, skipping.`);
            failed++;
            continue;
        }

        console.log(`📤 Uploading to R2: ${img.filename}...`);
        try {
            const buffer = fs.readFileSync(filePath);
            const r2Key = `achievement_images/achievement_${img.key}.png`;
            const r2Url = await uploadBufferToR2({
                key: r2Key,
                body: buffer,
                contentType: "image/png",
                cacheControl: "public, max-age=31536000, immutable"
            });

            console.log(`   ✅ Uploaded: ${r2Url}`);

            // Upsert into database
            await pool.query(
                `INSERT INTO achievement_images (key, title, cloudinary_url, display_order, is_active)
                 VALUES ($1, $2, $3, $4, TRUE)
                 ON CONFLICT (key) DO UPDATE
                 SET cloudinary_url = EXCLUDED.cloudinary_url, title = EXCLUDED.title, display_order = EXCLUDED.display_order`,
                [img.key, img.title, r2Url, img.display_order]
            );

            console.log(`   📝 Database updated: ${img.key} → ${r2Url}`);
            uploaded++;
        } catch (err) {
            console.error(`   ❌ Failed to upload ${img.filename}:`, err.message);
            failed++;
        }
    }

    console.log("\n─────────────────────────────────────────");
    console.log(`✅ Uploaded: ${uploaded}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log("─────────────────────────────────────────");

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
