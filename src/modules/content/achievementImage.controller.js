const pool = require("../../core/db/pool");

exports.getAll = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, key, title, cloudinary_url as url 
             FROM achievement_images 
             WHERE is_active = TRUE 
             ORDER BY display_order ASC`
        );
        
        return res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error("[AchievementImages] Error fetching images:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};
