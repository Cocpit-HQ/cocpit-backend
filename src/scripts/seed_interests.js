require("dotenv").config();
const pool = require("../core/db/pool");

const interests = [
    { name: 'Artificial Intelligence', slug: 'ai', category: 'Technology' },
    { name: 'Technology', slug: 'tech', category: 'Technology' },
    { name: 'Marketing', slug: 'marketing', category: 'Business' },
    { name: 'Startups', slug: 'startups', category: 'Business' },
    { name: 'Finance', slug: 'finance', category: 'Business' },
    { name: 'Content Creation', slug: 'content', category: 'Creative' },
    { name: 'Remote Work', slug: 'remote-jobs', category: 'Lifestyle' },
    { name: 'Design', slug: 'design', category: 'Creative' }
];

const seed = async () => {
    try {
        console.log("🌱 Seeding interests...");
        for (const interest of interests) {
            await pool.query(
                `INSERT INTO interests (name, slug, category) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (slug) DO UPDATE SET 
                    name = EXCLUDED.name, 
                    category = EXCLUDED.category,
                    updated_at = NOW()`,
                [interest.name, interest.slug, interest.category]
            );
        }
        console.log("✅ Seeding completed successfully");
        process.exit(0);
    } catch (err) {
        console.error("❌ Seeding failed:", err);
        process.exit(1);
    }
};

seed();
