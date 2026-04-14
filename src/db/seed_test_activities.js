const { logActivity } = require('../utils/activityLogger');
require('dotenv').config();

const seed = async () => {
    const testUserId = '6761c039-1c93-4aa8-bf92-9286d7a384c4'; // test@gmail.com
    console.log(`🌱 Seeding activities for user: ${testUserId}`);

    try {
        // Log a mix of actions to trigger different personas
        await logActivity({ userId: testUserId, action: 'apply_job' }); // Job Seeker (10 points)
        await logActivity({ userId: testUserId, action: 'view_job' });  // Job Seeker (2 points)
        await logActivity({ userId: testUserId, action: 'create_post' }); // Creator (8 points)
        await logActivity({ userId: testUserId, action: 'view_event' });  // Event (2 points)

        console.log("✅ Activities seeded successfully!");
    } catch (err) {
        console.error("❌ Seeding failed:", err.message);
    } finally {
        process.exit(0);
    }
};

seed();
