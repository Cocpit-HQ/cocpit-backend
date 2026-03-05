const pool = require("../../core/db/pool");

// 1️⃣ Create Folder
exports.createFolder = async (req, res) => {
    const { name, companyId } = req.body;
    const userId = req.user.sub;

    if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, message: "Folder name is required" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO saved_folders (user_id, org_id, name) VALUES ($1, $2, $3) RETURNING *`,
            [userId, companyId || null, name.trim()]
        );
        return res.status(201).json({ success: true, folder: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ success: false, message: "Folder with this name already exists" });
        }
        console.error("Create Folder Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// 2️⃣ Get Folders
exports.getFolders = async (req, res) => {
    const userId = req.user.sub;
    const { companyId } = req.query;
    try {
        const actorId = companyId || userId;
        const isOrgActor = !!companyId;

        // Get folders with post counts
        const result = await pool.query(
            `SELECT sf.*, 
                    (SELECT COUNT(*) FROM saved_post sp WHERE sp.folder_id = sf.folder_id)::int AS post_count
             FROM saved_folders sf
             WHERE sf.user_id = $1 AND (
                 ${isOrgActor ? 'sf.org_id = $2::uuid' : 'sf.org_id IS NULL'}
             )
             ORDER BY sf.created_at DESC`,
            isOrgActor ? [userId, companyId] : [userId]
        );
        return res.status(200).json({ success: true, folders: result.rows });
    } catch (error) {
        console.error("Get Folders Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// 3️⃣ Rename Folder
exports.renameFolder = async (req, res) => {
    const { folderId } = req.params;
    const { name, companyId } = req.body;
    const userId = req.user.sub;

    if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, message: "New name is required" });
    }

    try {
        const actorId = companyId || userId;
        const isOrgActor = !!companyId;

        const result = await pool.query(
            `UPDATE saved_folders SET name = $1, updated_at = NOW() 
             WHERE folder_id = $2 AND user_id = $3 AND (
                 ${isOrgActor ? 'org_id = $4::uuid' : 'org_id IS NULL'}
             ) RETURNING *`,
            isOrgActor ? [name.trim(), folderId, userId, companyId] : [name.trim(), folderId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Folder not found" });
        }

        return res.status(200).json({ success: true, folder: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: "Folder with this name already exists" });
        }
        console.error("Rename Folder Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// 4️⃣ Delete Folder
exports.deleteFolder = async (req, res) => {
    const { folderId } = req.params;
    const { companyId } = req.query;
    const userId = req.user.sub;

    try {
        const isOrgActor = !!companyId;
        const result = await pool.query(
            `DELETE FROM saved_folders WHERE folder_id = $1 AND user_id = $2 AND (
                ${isOrgActor ? 'org_id = $3::uuid' : 'org_id IS NULL'}
            ) RETURNING *`,
            isOrgActor ? [folderId, userId, companyId] : [folderId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Folder not found" });
        }

        return res.status(200).json({ success: true, message: "Folder deleted" });
    } catch (error) {
        console.error("Delete Folder Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};


// 5️⃣ Toggle Save / Save to Folder
exports.toggleSavePost = async (req, res) => {
    const { postId } = req.params;
    const { folderId, companyId } = req.body; // Optional. If present, we force save/move.
    const userId = req.user.sub;

    try {
        const isOrgActor = !!companyId;

        // Check if already saved
        const existing = await pool.query(
            `SELECT * FROM saved_post WHERE user_id = $1 AND post_id = $2 AND (
                ${isOrgActor ? 'org_id = $3::uuid' : 'org_id IS NULL'}
            )`,
            isOrgActor ? [userId, postId, companyId] : [userId, postId]
        );

        if (folderId !== undefined) {
            if (existing.rows.length > 0) {
                // Move to folder
                await pool.query(
                    `UPDATE saved_post SET folder_id = $1, saved_at = NOW() WHERE user_id = $2 AND post_id = $3 AND (
                        ${isOrgActor ? 'org_id = $4::uuid' : 'org_id IS NULL'}
                    )`,
                    isOrgActor ? [folderId, userId, postId, companyId] : [folderId, userId, postId]
                );
                return res.status(200).json({ success: true, saved: true, message: "Post moved to folder" });
            } else {
                // Insert with folder
                await pool.query(
                    `INSERT INTO saved_post (user_id, org_id, post_id, folder_id) VALUES ($1, $2, $3, $4)`,
                    [userId, companyId || null, postId, folderId]
                );
                return res.status(200).json({ success: true, saved: true, message: "Post saved to folder" });
            }
        }

        // Legacy Toggle Behavior
        if (existing.rows.length > 0) {
            // Unsave
            await pool.query(
                `DELETE FROM saved_post WHERE user_id = $1 AND post_id = $2 AND (
                    ${isOrgActor ? 'org_id = $3::uuid' : 'org_id IS NULL'}
                )`,
                isOrgActor ? [userId, postId, companyId] : [userId, postId]
            );
            return res.status(200).json({ success: true, saved: false, message: "Post unsaved" });
        }

        // Save (Default NULL folder)
        await pool.query(
            `INSERT INTO saved_post (user_id, org_id, post_id) VALUES ($1, $2, $3)`,
            [userId, companyId || null, postId]
        );

        return res.status(200).json({ success: true, saved: true, message: "Post saved" });

    } catch (error) {
        console.error("Toggle Save Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// 6️⃣ Get Saved Posts (with Folder support)
exports.getSavedPosts = async (req, res) => {
    const userId = req.user.sub;
    const { folderId, page = 1, limit = 20, companyId } = req.query; // Added pagination
    const offset = (page - 1) * limit;

    try {
        const isOrgActor = !!companyId;
        let queryParams = [userId];
        let queryText = `SELECT 
            p.*, 
            sp.saved_at,
            COALESCE(comp_auth.name, u_auth.full_name) AS author_name, 
            COALESCE(comp_auth.logo_url, u_auth.avatar_url) AS author_avatar,
            COALESCE(
                (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
                 FROM post_media pm WHERE pm.post_id = p.post_id),
                '[]'::json
            ) AS media,
            (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
            (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

            -- Identity Aware states
            EXISTS(
                SELECT 1 FROM post_likes pl_me 
                WHERE pl_me.post_id = p.post_id 
                AND (
                    ${isOrgActor ? 'pl_me.org_id = $2::uuid' : 'pl_me.user_id = $1 AND pl_me.org_id IS NULL'}
                )
            ) AS is_liked,
            EXISTS(
                SELECT 1 FROM post_comments pc_me 
                WHERE pc_me.post_id = p.post_id 
                AND (
                    ${isOrgActor ? 'pc_me.author_org_id = $2::uuid' : 'pc_me.author_id = $1 AND pc_me.author_org_id IS NULL'}
                )
            ) AS is_commented,
            true AS is_saved
         FROM saved_post sp
         JOIN posts p ON p.post_id = sp.post_id
         JOIN users u_auth ON u_auth.user_id = p.author_id
         LEFT JOIN organizations comp_auth ON comp_auth.org_id = p.author_org_id
         WHERE sp.user_id = $1 AND (
             ${isOrgActor ? 'sp.org_id = $2::uuid' : 'sp.org_id IS NULL'}
         )`;

        let paramIndex = isOrgActor ? 3 : 2;
        if (isOrgActor) queryParams.push(companyId);

        if (folderId === 'null' || folderId === 'unsorted') {
            queryText += ` AND sp.folder_id IS NULL`;
        } else if (folderId && folderId !== 'all') {
            queryParams.push(folderId);
            queryText += ` AND sp.folder_id = $${paramIndex}`;
            paramIndex++;
        }

        queryText += ` ORDER BY sp.saved_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const result = await pool.query(queryText, queryParams);

        // Check if there might be more (simple heuristic: if we got 'limit' items, maybe more)
        const hasMore = result.rows.length === parseInt(limit);

        return res.status(200).json({ success: true, posts: result.rows, hasMore, page: parseInt(page) });

    } catch (error) {
        console.error("Get Saved Posts Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// 7️⃣ Check if Post is Saved (and return folderId)
exports.checkIfPostSaved = async (req, res) => {
    const { postId } = req.params;
    const { companyId } = req.query;
    const userId = req.user.sub;

    try {
        const isOrgActor = !!companyId;
        const result = await pool.query(
            `SELECT folder_id FROM saved_post WHERE user_id = $1 AND post_id = $2 AND (
                ${isOrgActor ? 'org_id = $3::uuid' : 'org_id IS NULL'}
            )`,
            isOrgActor ? [userId, postId, companyId] : [userId, postId]
        );

        return res.status(200).json({
            success: true,
            isSaved: result.rows.length > 0,
            folderId: result.rows.length > 0 ? result.rows[0].folder_id : null
        });

    } catch (error) {
        console.error("Check Saved Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};