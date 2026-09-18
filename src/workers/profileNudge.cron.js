const pool = require("../core/db/pool");
const logger = require("../core/logger/logger");
const profileRepo = require("../modules/profile/profile.repository");
const profileCalc = require("../modules/profile/profile.calculator");
const socketService = require("../core/infrastructure/socket.service");

/**
 * Profile Incomplete Nudge Cron Worker
 * Checks user profiles. If a profile is incomplete (score < 100) and hasn't been notified recently,
 * it triggers a silent in-app nudge.
 */
const processProfileNudges = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            client.once('error', (err) => {
                logger.error("[ProfileNudgeCron] Unexpected client error:", err.message);
            });
        } catch (connErr) {
            logger.warn("[ProfileNudgeCron] Database connection unavailable. Skipping execution.");
            return;
        }

        logger.info("[ProfileNudgeCron] Starting profile incomplete nudge check...");
        
        // 1. Fetch active professionals who might need a nudge
        // Optimization: We could filter users who already got this notification today
            const usersResult = await client.query(`
                SELECT u.user_id, p.account_type 
                FROM active_users u
                LEFT JOIN profiles p ON u.user_id = p.user_id
                WHERE p.account_type != 'Organization' OR p.account_type IS NULL
            `);
        
        const users = usersResult.rows;
        let nudgedCount = 0;

        for (const user of users) {
            const userId = user.user_id;

            // 2. Check if already notified recently (e.g. in last 1 day)
            const notifCheck = await client.query(`
                SELECT 1 FROM notifications 
                WHERE user_id = $1 AND type = 'profile_incomplete_nudge' 
                AND created_at > NOW() - INTERVAL '1 day'
                LIMIT 1
            `, [userId]);

            if (notifCheck.rowCount > 0) {
                continue; // Already nudged recently
            }

            // 3. Calculate full profile score
            const fullProfile = await profileRepo.getFullProfile(userId);
            if (!fullProfile) continue; // Profile not set up yet fully to even have a record

            
            const profileId = fullProfile.profile_id;
            const skills = await profileRepo.getSkills(profileId);
            const experiences = await profileRepo.getExperiences(profileId);
            const projects = await profileRepo.getProjects(profileId);
            const educations = await profileRepo.getEducations(profileId);
            
            // Flatten experiences as expected by calculator
            const flatExperiences = (experiences || []).flatMap(orgGroup => 
                (orgGroup.experiences || []).map(role => ({
                    company_name: orgGroup.company_name,
                    title: role.title,
                    start_date: role.start_date,
                    description: role.description
                }))
            );

            const profileScoreData = profileCalc.calculateFullProfileScore(
                fullProfile, 
                skills || [], 
                flatExperiences, 
                projects || [], 
                educations || []
            );

            // 4. Send Nudge if score < 100
            if (profileScoreData.score < 100) {
                const title = "Finish setting up your profile";
                const message = "Complete your profile to improve visibility and reach";
                const type = "profile_incomplete_nudge";

                try {
                    await client.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [
                            userId, 
                            userId, // Or system UUID if available
                            type, 
                            message,
                            JSON.stringify({ title })
                        ]
                    );

                    // Send silent socket notification
                    const payload = {
                        type,
                        title,
                        message,
                        timestamp: new Date().toISOString()
                    };
                    socketService.notifyUser(userId, "notification", payload);
                    
                    nudgedCount++;
                } catch (err) {
                    logger.error(`[ProfileNudgeCron] Failed to nudge user ${userId}:`, err.message);
                }
            }
        }

        logger.info(`[ProfileNudgeCron] Completed successfully. Nudged ${nudgedCount} users.`);

    } catch (error) {
        logger.error("[ProfileNudgeCron] Critical error during execution:", error);
    } finally {
        if (client) {
            client.release();
        }
    }
};

module.exports = {
    processProfileNudges
};
