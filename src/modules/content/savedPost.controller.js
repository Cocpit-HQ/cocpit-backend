const pool = require("../../core/db/pool");
const { logActivity: logIntentActivity } = require("../../utils/activityLogger");
const cloudinary = require("../../core/infrastructure/cloudinary.client");
const socketService = require("../../core/infrastructure/socket.service");

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
        const err = new Error("Active organization actor does not match requested organization");
        err.statusCode = 403;
        throw err;
    }

    return actorOrgId;
};

const getSavedPostActorScope = (req, fallbackOrgId = null) => {
    const orgId = getRequestedOrganizationActorId(req, fallbackOrgId);

    return {
        userId: req.user.sub,
        orgId,
        isOrgActor: !!orgId,
    };
};

const notifySavedUpdate = (orgId, userId, event, payload) => {
    if (orgId) {
        socketService.notifyOrg(orgId, event, payload);
    }
    if (userId) {
        socketService.notifyUser(userId, event, payload);
    }
};

const resolveCoverImage = async (file, rawCoverImage) => {
    if (file) {
        return (file.path || file.secure_url || '').replace(/\\/g, "/");
    }
    if (typeof rawCoverImage === 'string' && rawCoverImage.trim()) {
        const val = rawCoverImage.trim();
        if (val.startsWith('data:')) {
            try {
                const uploadRes = await cloudinary.uploader.upload(val, {
                    folder: "covers",
                    resource_type: "image"
                });
                return (uploadRes.secure_url || uploadRes.url || '').replace(/\\/g, "/");
            } catch (err) {
                console.error("[savedPost.controller] Failed to upload base64 image to Cloudinary:", err);
                return null;
            }
        }
        if (val.startsWith('http')) {
            return val;
        }
    }
    return null;
};

// 1️⃣ Create Folder
exports.createFolder = async (req, res) => {
    console.log("Create Folder Body:", req.body, "File:", req.file);
    const { name, companyId, coverImage: bodyCoverImage, cover_image: bodyCoverImageAlt } = req.body;
    const raw = bodyCoverImage || bodyCoverImageAlt;
    const coverImage = await resolveCoverImage(req.file, raw);

    if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, message: "Folder name is required" });
    }
    if (name.trim().length > 25) {
        return res.status(400).json({ success: false, message: "Folder name cannot exceed 25 characters" });
    }

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);
        const result = await pool.query(
            `INSERT INTO saved_folders (user_id, org_id, name, cover_image) VALUES ($1, $2, $3, $4) RETURNING *`,
            [userId, orgId, name.trim(), coverImage]
        );

        await notifySavedUpdate(isOrgActor ? orgId : null, userId, "saved_folders_updated", { folder: result.rows[0], action: "create" });

        return res.status(201).json({ success: true, folder: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ success: false, message: "Folder with this name already exists" });
        }
        console.error("Create Folder Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};

// 2️⃣ Get Folders
exports.getFolders = async (req, res) => {
    const { companyId } = req.query;
    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        let queryText;
        let queryParams;

        if (isOrgActor) {
            queryText = `SELECT sf.*, 
                    (SELECT COUNT(*) FROM saved_post sp WHERE sp.folder_id = sf.folder_id)::int AS post_count
             FROM saved_folders sf
             WHERE sf.org_id = $1::uuid
             ORDER BY sf.created_at DESC`;
            queryParams = [orgId];
        } else {
            queryText = `SELECT sf.*, 
                    (SELECT COUNT(*) FROM saved_post sp WHERE sp.folder_id = sf.folder_id)::int AS post_count
             FROM saved_folders sf
             WHERE sf.user_id = $1 AND sf.org_id IS NULL
             ORDER BY sf.created_at DESC`;
            queryParams = [userId];
        }

        const result = await pool.query(queryText, queryParams);
        return res.status(200).json({ success: true, folders: result.rows });
    } catch (error) {
        console.error("Get Folders Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};

// 3️⃣ Rename Folder
exports.renameFolder = async (req, res) => {
    const { folderId } = req.params;
    const { name, companyId, coverImage: bodyCoverImage, cover_image: bodyCoverImageAlt } = req.body;
    const raw = bodyCoverImage || bodyCoverImageAlt;
    const newCoverImage = await resolveCoverImage(req.file, raw);

    if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, message: "New name is required" });
    }
    if (name.trim().length > 25) {
        return res.status(400).json({ success: false, message: "New name cannot exceed 25 characters" });
    }

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        let queryText;
        let queryParams;

        if (isOrgActor) {
            queryText = `UPDATE saved_folders SET name = $1, cover_image = COALESCE($2, cover_image), updated_at = NOW() 
             WHERE folder_id = $3 AND org_id = $4::uuid RETURNING *`;
            queryParams = [name.trim(), newCoverImage, folderId, orgId];
        } else {
            queryText = `UPDATE saved_folders SET name = $1, cover_image = COALESCE($2, cover_image), updated_at = NOW() 
             WHERE folder_id = $3 AND user_id = $4 AND org_id IS NULL RETURNING *`;
            queryParams = [name.trim(), newCoverImage, folderId, userId];
        }

        const result = await pool.query(queryText, queryParams);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Folder not found" });
        }

        await notifySavedUpdate(isOrgActor ? orgId : null, userId, "saved_folders_updated", { folder: result.rows[0], action: "rename" });

        return res.status(200).json({ success: true, folder: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: "Folder with this name already exists" });
        }
        console.error("Rename Folder Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};

// 4️⃣ Delete Folder
exports.deleteFolder = async (req, res) => {
    const { folderId } = req.params;
    const { companyId } = req.query;

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        if (isOrgActor) {
            await pool.query(
                `DELETE FROM saved_post WHERE folder_id = $1 AND org_id = $2::uuid`,
                [folderId, orgId]
            );

            const result = await pool.query(
                `DELETE FROM saved_folders WHERE folder_id = $1 AND org_id = $2::uuid RETURNING *`,
                [folderId, orgId]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Folder not found" });
            }

            await notifySavedUpdate(orgId, userId, "saved_folders_updated", { folderId, action: "delete" });
        } else {
            await pool.query(
                `DELETE FROM saved_post WHERE folder_id = $1 AND user_id = $2 AND org_id IS NULL`,
                [folderId, userId]
            );

            const result = await pool.query(
                `DELETE FROM saved_folders WHERE folder_id = $1 AND user_id = $2 AND org_id IS NULL RETURNING *`,
                [folderId, userId]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Folder not found" });
            }

            await notifySavedUpdate(null, userId, "saved_folders_updated", { folderId, action: "delete" });
        }

        return res.status(200).json({ success: true, message: "Folder deleted" });
    } catch (error) {
        console.error("Delete Folder Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};


// 5️⃣ Toggle Save / Save to Folder
exports.toggleSavePost = async (req, res) => {
    const { postId } = req.params;
    const { folderId, companyId } = req.body; // Optional. If present, we force save/move.

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        // Check if already saved
        const existingQuery = isOrgActor
            ? `SELECT * FROM saved_post WHERE post_id = $1 AND org_id = $2::uuid`
            : `SELECT * FROM saved_post WHERE user_id = $1 AND post_id = $2 AND org_id IS NULL`;

        const existingParams = isOrgActor ? [postId, orgId] : [userId, postId];
        const existing = await pool.query(existingQuery, existingParams);

        if (folderId !== undefined) {
            // Atomic UPSERT - handles concurrent requests and folder changes safely without duplicate key violations
            const upsertQuery = `
                INSERT INTO saved_post (user_id, org_id, post_id, folder_id, saved_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (user_id, post_id)
                DO UPDATE SET
                    folder_id = EXCLUDED.folder_id,
                    org_id = EXCLUDED.org_id,
                    saved_at = NOW()
            `;
            await pool.query(upsertQuery, [userId, orgId, postId, folderId]);

            await notifySavedUpdate(isOrgActor ? orgId : null, userId, "saved_posts_updated", { postId, folderId, saved: true });

            const message = existing.rows.length > 0 ? "Post moved to folder" : "Post saved to folder";
            return res.status(200).json({ success: true, saved: true, message });
        }

        // Legacy Toggle Behavior
        if (existing.rows.length > 0) {
            // Unsave
            const deleteQuery = isOrgActor
                ? `DELETE FROM saved_post WHERE post_id = $1 AND org_id = $2::uuid`
                : `DELETE FROM saved_post WHERE user_id = $1 AND post_id = $2 AND org_id IS NULL`;
            const deleteParams = isOrgActor ? [postId, orgId] : [userId, postId];
            await pool.query(deleteQuery, deleteParams);

            await notifySavedUpdate(isOrgActor ? orgId : null, userId, "saved_posts_updated", { postId, saved: false });

            return res.status(200).json({ success: true, saved: false, message: "Post unsaved" });
        }

        // Save (Default NULL folder) with ON CONFLICT DO NOTHING to prevent race conditions
        await pool.query(
            `INSERT INTO saved_post (user_id, org_id, post_id, saved_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, post_id) DO NOTHING`,
            [userId, orgId, postId]
        );

        // 🎯 Intent Layer: Log Save Post
        logIntentActivity({ userId, action: "save_post", metadata: { postId, orgId } });

        await notifySavedUpdate(isOrgActor ? orgId : null, userId, "saved_posts_updated", { postId, saved: true });

        return res.status(200).json({ success: true, saved: true, message: "Post saved" });

    } catch (error) {
        console.error("Toggle Save Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};

// 6️⃣ Get Saved Posts (with Folder support)
exports.getSavedPosts = async (req, res) => {
    const { folderId, page = 1, limit = 20, companyId } = req.query; // Added pagination
    const offset = (page - 1) * limit;

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        let queryParams = [];
        let whereClause = "";

        if (isOrgActor) {
            queryParams.push(orgId);
            whereClause = `sp.org_id = $1::uuid`;
        } else {
            queryParams.push(userId);
            whereClause = `sp.user_id = $1 AND sp.org_id IS NULL`;
        }

        let queryText = `SELECT 
            p.*, 
            p.content AS content,
            sp.saved_at,
            COALESCE(comp_auth.name, u_auth.full_name) AS author_name, 
            CASE WHEN p.author_org_id IS NOT NULL THEN comp_auth.logo_url ELSE u_auth.avatar_url END AS author_avatar,
            COALESCE(comp_auth.slug, u_auth.account_name) AS author_slug,
            CASE WHEN p.author_org_id IS NOT NULL THEN comp_auth.headline ELSE u_auth.headline END AS author_headline,
            COALESCE(
                (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
                 FROM post_media pm WHERE pm.post_id = p.post_id),
                '[]'::json
            ) AS media,
            (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'image' LIMIT 1) AS image_url,
            (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS post_url,
            ARRAY(SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'image') AS images,
            CASE 
                WHEN p.shared_post_id IS NOT NULL THEN
                    json_build_object(
                        'is_accessible', true,
                        'post_id', orig_p.post_id,
                        'content', orig_p.content,
                        'author', json_build_object(
                            'user_id', COALESCE(orig_p.author_org_id, u_orig.user_id),
                            'full_name', COALESCE(comp_orig.name, u_orig.full_name),
                            'avatar_url', CASE WHEN orig_p.author_org_id IS NOT NULL THEN comp_orig.logo_url ELSE u_orig.avatar_url END
                        ),
                        'media', COALESCE(
                            (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
                             FROM post_media pm WHERE pm.post_id = orig_p.post_id),
                            '[]'::json
                        ),
                        'poll', (
                            SELECT json_build_object(
                                'poll_id', pp_orig.poll_id,
                                'duration', COALESCE(pp_orig.duration, '1 day'),
                                'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp_orig.poll_id)::int,
                                'user_vote', (
                                    SELECT pv_u.option_id FROM poll_votes pv_u 
                                    WHERE pv_u.poll_id = pp_orig.poll_id 
                                    AND (
                                        ${isOrgActor ? 'pv_u.org_id = $1::uuid' : 'pv_u.voter_id = $1 AND pv_u.org_id IS NULL'}
                                    )
                                    LIMIT 1
                                ),
                                'is_active', (pp_orig.created_at + COALESCE(pp_orig.duration, '1 day')::interval > NOW()),
                                'options',
                                COALESCE(
                                    (
                                        SELECT json_agg(
                                            json_build_object(
                                                'option_id', po.option_id,
                                                'option_text', po.option_text,
                                                'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                                            )
                                        )
                                        FROM poll_options po
                                        WHERE po.poll_id = pp_orig.poll_id
                                    ),
                                    '[]'::json
                                )
                            )
                            FROM post_polls pp_orig
                            WHERE pp_orig.post_id = orig_p.post_id
                            LIMIT 1
                        )
                    )
                ELSE NULL
            END AS shared_post,
            (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
            (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,
            (SELECT COUNT(*) FROM saved_post sp_cnt WHERE sp_cnt.post_id = p.post_id)::int AS save_count,
            (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1))::int AS votes,
            (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",

            -- Full Poll Object with Options
            (
                SELECT json_build_object(
                    'poll_id', pp.poll_id,
                    'duration', COALESCE(pp.duration, '1 day'),
                    'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                    'user_vote', (
                        SELECT pv_u.option_id FROM poll_votes pv_u 
                        WHERE pv_u.poll_id = pp.poll_id 
                        AND (
                            ${isOrgActor ? 'pv_u.org_id = $1::uuid' : 'pv_u.voter_id = $1 AND pv_u.org_id IS NULL'}
                        )
                        LIMIT 1
                    ),
                    'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                    'options',
                    COALESCE(
                        (
                            SELECT json_agg(
                                json_build_object(
                                    'option_id', po.option_id,
                                    'option_text', po.option_text,
                                    'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                                )
                            )
                            FROM poll_options po
                            WHERE po.poll_id = pp.poll_id
                        ),
                        '[]'::json
                    )
                )
                FROM post_polls pp
                WHERE pp.post_id = p.post_id
                LIMIT 1
            ) AS poll,

            -- Identity Aware states
            EXISTS(
                SELECT 1 FROM active_post_likes pl_me 
                WHERE pl_me.post_id = p.post_id 
                AND (
                    ${isOrgActor ? 'pl_me.org_id = $1::uuid' : 'pl_me.user_id = $1 AND pl_me.org_id IS NULL'}
                )
            ) AS is_liked,
            EXISTS(
                SELECT 1 FROM active_post_comments pc_me 
                WHERE pc_me.post_id = p.post_id 
                AND (
                    ${isOrgActor ? 'pc_me.author_org_id = $1::uuid' : 'pc_me.author_id = $1 AND pc_me.author_org_id IS NULL'}
                )
            ) AS is_commented,
            true AS is_saved
         FROM saved_post sp
         JOIN posts p ON p.post_id = sp.post_id
         LEFT JOIN posts orig_p ON orig_p.post_id = p.shared_post_id
         JOIN active_users u_auth ON u_auth.user_id = p.author_id
         LEFT JOIN organizations comp_auth ON comp_auth.org_id = p.author_org_id
         LEFT JOIN active_users u_orig ON u_orig.user_id = orig_p.author_id
         LEFT JOIN organizations comp_orig ON comp_orig.org_id = orig_p.author_org_id
         WHERE ${whereClause}`;

        let paramIndex = 2;
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

        const formattedPosts = result.rows.map(row => {
            const firstImage = row.image_url || row.post_url || (Array.isArray(row.media) && row.media.length > 0 ? row.media[0].url : null);
            return {
                ...row,
                image_url: firstImage,
                post_url: firstImage,
                imageSrc: firstImage,
                images: Array.isArray(row.images) && row.images.length > 0 ? row.images : (firstImage ? [firstImage] : []),
                poll: row.poll || null
            };
        });

        return res.status(200).json({ success: true, posts: formattedPosts, hasMore, page: parseInt(page) });

    } catch (error) {
        console.error("Get Saved Posts Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};

// 7️⃣ Check if Post is Saved (and return folderId)
exports.checkIfPostSaved = async (req, res) => {
    const { postId } = req.params;
    const { companyId } = req.query;

    try {
        const { userId, orgId, isOrgActor } = getSavedPostActorScope(req, companyId || null);

        const queryText = isOrgActor
            ? `SELECT folder_id FROM saved_post WHERE post_id = $1 AND org_id = $2::uuid`
            : `SELECT folder_id FROM saved_post WHERE user_id = $1 AND post_id = $2 AND org_id IS NULL`;
        const queryParams = isOrgActor ? [postId, orgId] : [userId, postId];

        const result = await pool.query(queryText, queryParams);

        return res.status(200).json({
            success: true,
            isSaved: result.rows.length > 0,
            folderId: result.rows.length > 0 ? result.rows[0].folder_id : null
        });

    } catch (error) {
        console.error("Check Saved Error:", error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
    }
};
