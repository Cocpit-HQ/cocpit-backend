
exports.removeMention = async (req, res) => {
    const postId = req.params.id;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    if (!postId || (!userId && !orgId)) {
        return res.status(400).json({ message: "postId and actor context are required" });
    }

    try {
        let actorHandle = '';
        let actorName = '';

        if (orgId) {
            const orgResult = await pool.query("SELECT slug, name FROM organizations WHERE org_id = $1", [orgId]);
            if (orgResult.rowCount === 0) {
                return res.status(404).json({ message: "Organization not found" });
            }
            actorHandle = orgResult.rows[0].slug;
            actorName = orgResult.rows[0].name;
        } else {
            const userResult = await pool.query("SELECT username, full_name FROM users WHERE user_id = $1", [userId]);
            if (userResult.rowCount === 0) {
                return res.status(404).json({ message: "User not found" });
            }
            actorHandle = userResult.rows[0].username;
            actorName = userResult.rows[0].full_name;
        }

        const postResult = await pool.query("SELECT content FROM posts WHERE post_id = $1", [postId]);
        if (postResult.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        let newContent = postResult.rows[0].content || '';

        if (actorHandle) {
            const escapeHandle = actorHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const structuredMatch = new RegExp(`@\\[([^\\]]+)\\]\\(${escapeHandle}\\)`, 'gi');
            newContent = newContent.replace(structuredMatch, '$1');

            const legacyMatch = new RegExp(`@(${escapeHandle})\\b`, 'gi');
            newContent = newContent.replace(legacyMatch, '$1');
        }

        if (actorName) {
            const escapeName = actorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const structuredNameMatch = new RegExp(`@\\[(${escapeName})\\]\\([^)]+\\)`, 'gi');
            newContent = newContent.replace(structuredNameMatch, '$1');
        }

        if (newContent !== postResult.rows[0].content) {
            await pool.query("UPDATE posts SET content = $1, updated_at = now() WHERE post_id = $2", [newContent, postId]);
        }

        res.status(200).json({ message: "Mention removed successfully", content: newContent });
    } catch (err) {
        console.error("Error in removeMention:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};
