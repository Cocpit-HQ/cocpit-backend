const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");

exports.syncPostTags = async (req, res) => {
    const { postId, tags, companyId } = req.body;
    const actorUserId = req.user?.sub || req.user?.user_id;

    // Use empty array if tags is undefined
    const validTags = Array.isArray(tags) ? tags : [];
    const uniqueValidTags = [...new Set(validTags)];
    const notificationsToEmit = [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Capture currently active tags so we only notify for newly tagged users
        const existingTagsRes = await client.query(
            `SELECT tagged_user_id FROM post_tags WHERE post_id = $1 AND is_active_tag = true`,
            [postId]
        );
        const existingActiveTagSet = new Set(existingTagsRes.rows.map(row => row.tagged_user_id));

        // Step 1: Soft-delete (deactivate) tags that are NOT in the new list
        if (uniqueValidTags.length > 0) {
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1 AND tagged_user_id != ALL($2::uuid[])
            `, [postId, uniqueValidTags]);
        } else {
            // If the array is completely empty, deactivate ALL tags for this post
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1
            `, [postId]);
        }

        // Step 2: Upsert (Insert or Reactivate) the new tags
        if (uniqueValidTags.length > 0) {
            // We use UNNEST($2::uuid[]) to efficiently batch insert multiple rows
            // ON CONFLICT handles if the user was tagged previously
            await client.query(`
                INSERT INTO post_tags (post_id, tagged_user_id, is_active_tag, updated_at)
                SELECT $1, unnest($2::uuid[]), true, NOW()
                ON CONFLICT (post_id, tagged_user_id) 
                DO UPDATE SET 
                    is_active_tag = true,
                    updated_at = NOW()
            `, [postId, uniqueValidTags]);
        }

        // Step 3: Notify only newly tagged users (new active tags not previously active)
        const newlyTaggedUserIds = uniqueValidTags.filter(taggedUserId => !existingActiveTagSet.has(taggedUserId));
        const filteredNewlyTaggedUserIds = newlyTaggedUserIds.filter(taggedUserId => taggedUserId !== actorUserId);

        if (filteredNewlyTaggedUserIds.length > 0 && actorUserId) {
            let senderName = "Someone";
            let senderAvatar = null;

            if (companyId) {
                const orgRes = await client.query(
                    `SELECT name, logo_url FROM organizations WHERE org_id = $1`,
                    [companyId]
                );
                if (orgRes.rowCount > 0) {
                    senderName = orgRes.rows[0].name;
                    senderAvatar = orgRes.rows[0].logo_url;
                }
            } else {
                const userRes = await client.query(
                    `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                    [actorUserId]
                );
                if (userRes.rowCount > 0) {
                    senderName = userRes.rows[0].full_name;
                    senderAvatar = userRes.rows[0].avatar_url;
                }
            }

            const notificationText = `${senderName} tagged you in a post`;

            for (const taggedUserId of filteredNewlyTaggedUserIds) {
                const metadata = { post_id: postId, org_id: companyId || null };

                const notifRes = await client.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     RETURNING notification_id`,
                    [taggedUserId, actorUserId, "post_tag", notificationText, postId, JSON.stringify(metadata)]
                );

                notificationsToEmit.push({
                    taggedUserId,
                    payload: {
                        notification_id: notifRes.rows[0].notification_id,
                        type: "post_tag",
                        text: notificationText,
                        from: actorUserId,
                        senderName,
                        senderAvatar,
                        referenceId: postId,
                        metadata,
                        time: "Just now"
                    }
                });
            }
        }

        await client.query('COMMIT');

        for (const item of notificationsToEmit) {
            socketService.notifyUser(item.taggedUserId, "notification", item.payload);
        }

        return res.status(200).json({
            message: "Tags synced successfully",
            notified_count: notificationsToEmit.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error syncing post tags:", error);
        return res.status(500).json({ error: "Internal server error while syncing tags" });
    } finally {
        client.release();
    }
};

exports.getActivePostTags = async (req, res) => {
    const { postId } = req.query;

    if (!postId) {
        return res.status(400).json({ error: "postId query parameter is required" });
    }

    try {
        const query = `
            SELECT 
                u.user_id AS id,
                u.full_name,
                u.account_name,
                u.headline,
                u.avatar_url,
                p.account_type,
                'USER'::text as type,
                NULL::text as slug,
                NULL::text as industry,
                pt.tag_id, 
                pt.updated_at AS tagged_at
            FROM post_tags pt
            JOIN active_users u ON pt.tagged_user_id = u.user_id
            LEFT JOIN profiles p ON u.user_id = p.user_id
            WHERE pt.post_id = $1 AND pt.is_active_tag = true
            ORDER BY pt.updated_at DESC
        `;
        
        const { rows } = await pool.query(query, [postId]);

        return res.status(200).json({
            postId,
            active_tags_count: rows.length,
            tags: rows
        });

    } catch (error) {
        console.error("Error fetching active tags:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};
