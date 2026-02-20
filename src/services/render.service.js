const cloudinary = require("../config/cloudinary");
const pool = require("../db/pool");

/**
 * Generates a final rendered URL for a story using Cloudinary transformations.
 * Updates the story record with the final URL and status.
 *
 * @param {string} storyId - The ID of the story to render.
 * @param {string} publicId - The Cloudinary public ID of the base media.
 * @param {string} mediaType - 'image' or 'video'.
 * @param {object} metadata - content (text), styles (color, font), etc.
 */
exports.renderStory = async (storyId, publicId, mediaType, metadata = {}) => {
    console.log(`[RenderService] Starting render for story ${storyId}`);

    try {
        // 1. Update status to 'rendering'
        await pool.query("UPDATE stories SET render_status = 'rendering' WHERE story_id = $1", [storyId]);

        // 2. Construct Transformation
        const transformation = [];

        // Support for Layers (Text/Image overlays)
        if (metadata.layers && Array.isArray(metadata.layers)) {
            metadata.layers.forEach(layer => {
                if (layer.type === 'text' && layer.content) {
                    const style = layer.style || {};
                    transformation.push({
                        overlay: {
                            font_family: style.fontFamily || "Arial",
                            font_size: style.fontSize || 30,
                            text: layer.content
                        },
                        color: style.color || "#FFFFFF",
                        gravity: style.gravity || "center",
                        y: style.y || 0,
                        x: style.x || 0
                    });
                }
                // Add support for other layer types here if needed
            });
        }

        // Legacy support for direct metadata (backward compatibility if needed)
        if (metadata.text && (!metadata.layers || metadata.layers.length === 0)) {
            const style = metadata.style || {};
            transformation.push({
                overlay: {
                    font_family: style.fontFamily || "Arial",
                    font_size: style.fontSize || 30,
                    text: metadata.text
                },
                color: style.color || "#FFFFFF",
                gravity: style.gravity || "center",
                y: style.y || 0,
                x: style.x || 0
            });
        }

        // 3. Generate Final URL
        const finalUrl = cloudinary.url(publicId, {
            resource_type: mediaType,
            transformation: transformation,
            secure: true
        });

        // 4. Update DB with Final URL
        await pool.query(
            "UPDATE stories SET render_status = 'ready', final_url = $1 WHERE story_id = $2",
            [finalUrl, storyId]
        );

        console.log(`[RenderService] Render complete for story ${storyId}. URL: ${finalUrl}`);
        return finalUrl;

    } catch (err) {
        console.error(`[RenderService] Failed to render story ${storyId}:`, err);
        // await pool.query("UPDATE stories SET render_status = 'failed' WHERE story_id = $1", [storyId]);
        // For verification purposes, re-throw the error to see it in the script
        throw err;
    }
};
