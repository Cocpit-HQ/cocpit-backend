const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");

// Ensure post_tags.tagged_user_id can store both user_id and org_id without strict FK restriction to users table
pool.query(`ALTER TABLE post_tags DROP CONSTRAINT IF EXISTS post_tags_tagged_user_id_fkey;`).catch(err => {
    console.error("[postTags] Migration: Error dropping post_tags FK constraint:", err?.message || err);
});

async function filterAllowedTaggedUserIds(client, actorUserId, actorOrgId, targetUserIds) {
    if (!targetUserIds || targetUserIds.length === 0) return [];

    const usersRes = await client.query(
        `SELECT user_id, COALESCE(tag_permission, 'everyone') AS tag_permission
         FROM users
         WHERE user_id = ANY($1::uuid[])`,
        [targetUserIds]
    );

    const allowedUserIds = [];
    const foundUserIds = new Set();

    for (const u of usersRes.rows) {
        const { user_id, tag_permission } = u;
        foundUserIds.add(user_id);

        if (tag_permission === 'no_one') {
            continue;
        }

        if (tag_permission === 'everyone' || !actorUserId) {
            allowedUserIds.push(user_id);
            continue;
        }

        if (tag_permission === 'connections_only') {
            const connRes = await client.query(
                `SELECT 1 FROM connections
                 WHERE (user_id = $1 AND connected_user_id = $2)
                    OR (user_id = $2 AND connected_user_id = $1)`,
                [actorUserId, user_id]
            );
            if (connRes.rowCount > 0) {
                allowedUserIds.push(user_id);
            }
            continue;
        }

        if (tag_permission === 'followers_only') {
            const followRes = await client.query(
                `SELECT 1 FROM followers
                 WHERE follower_id = $1 AND following_id = $2`,
                [actorUserId, user_id]
            );
            if (followRes.rowCount > 0) {
                allowedUserIds.push(user_id);
            }
            continue;
        }

        allowedUserIds.push(user_id);
    }

    // Check Organization tag permissions for any IDs not found in users table
    const remainingOrgIds = targetUserIds.filter(id => !foundUserIds.has(id));
    if (remainingOrgIds.length > 0) {
        const orgsRes = await client.query(
            `SELECT o.org_id, COALESCE(ops.tag_permission, 'everyone') AS tag_permission
             FROM organizations o
             LEFT JOIN organization_privacy_settings ops ON o.org_id = ops.org_id
             WHERE o.org_id = ANY($1::uuid[]) AND o.is_deleted = FALSE`,
            [remainingOrgIds]
        );

        for (const o of orgsRes.rows) {
            const { org_id, tag_permission } = o;

            if (tag_permission === 'no_one') continue;
            if (tag_permission === 'everyone' || (!actorUserId && !actorOrgId)) {
                allowedUserIds.push(org_id);
                continue;
            }

            if (tag_permission === 'followers_only') {
                let followRes;
                if (actorOrgId) {
                    followRes = await client.query(
                        `SELECT 1 FROM organization_org_follows WHERE follower_org_id = $1 AND following_org_id = $2`,
                        [actorOrgId, org_id]
                    );
                } else {
                    followRes = await client.query(
                        `SELECT 1 FROM organization_followers WHERE user_id = $1 AND org_id = $2`,
                        [actorUserId, org_id]
                    );
                }
                if (followRes.rowCount > 0) {
                    allowedUserIds.push(org_id);
                }
                continue;
            }
            allowedUserIds.push(org_id);
        }
    }

    return allowedUserIds;
}

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

        // Filter requested tags based on target users' tag_permission settings
        const allowedTags = await filterAllowedTaggedUserIds(client, actorUserId, req.actor?.orgId, uniqueValidTags);

        // Capture currently active tags so we only notify for newly tagged users
        const existingTagsRes = await client.query(
            `SELECT tagged_user_id FROM post_tags WHERE post_id = $1 AND is_active_tag = true`,
            [postId]
        );
        const existingActiveTagSet = new Set(existingTagsRes.rows.map(row => row.tagged_user_id));

        // Step 1: Soft-delete (deactivate) tags that are NOT in the new allowed list
        if (allowedTags.length > 0) {
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1 AND tagged_user_id != ALL($2::uuid[])
            `, [postId, allowedTags]);
        } else {
            // If the array is completely empty, deactivate ALL tags for this post
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1
            `, [postId]);
        }

        // Step 2: Upsert (Insert or Reactivate) the allowed tags
        if (allowedTags.length > 0) {
            await client.query(`
                INSERT INTO post_tags (post_id, tagged_user_id, is_active_tag, updated_at)
                SELECT $1, unnest($2::uuid[]), true, NOW()
                ON CONFLICT (post_id, tagged_user_id) 
                DO UPDATE SET 
                    is_active_tag = true,
                    updated_at = NOW()
            `, [postId, allowedTags]);
        }

        // Step 3: Notify only newly tagged users (new active tags not previously active)
        const newlyTaggedUserIds = allowedTags.filter(taggedUserId => !existingActiveTagSet.has(taggedUserId));
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

            const notificationText = "tagged you in a post";

            for (const taggedUserId of filteredNewlyTaggedUserIds) {
                const metadata = { post_id: postId, org_id: companyId || null };

                // Check if target is an individual user or an organization
                const userCheck = await client.query(`SELECT 1 FROM users WHERE user_id = $1`, [taggedUserId]);

                if (userCheck.rowCount > 0) {
                    const notifRes = await client.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         RETURNING notification_id`,
                        [taggedUserId, actorUserId, "post_tag", notificationText, postId, JSON.stringify(metadata)]
                    );

                    notificationsToEmit.push({
                        targetId: taggedUserId,
                        isOrg: false,
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
                } else {
                    // Target is an Organization: create notifications for its active team members
                    const membersRes = await client.query(
                        `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
                        [taggedUserId]
                    );

                    for (const m of membersRes.rows) {
                        const notifRes = await client.query(
                            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             RETURNING notification_id`,
                            [m.user_id, actorUserId, "post_tag", notificationText, postId, JSON.stringify(metadata)]
                        );

                        notificationsToEmit.push({
                            targetId: m.user_id,
                            isOrg: false,
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

                    notificationsToEmit.push({
                        targetId: taggedUserId,
                        isOrg: true,
                        payload: {
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
        }

        await client.query('COMMIT');

        for (const item of notificationsToEmit) {
            if (item.isOrg) {
                socketService.notifyOrg(item.targetId, "notification", item.payload);
                socketService.notifyOrg(item.targetId, "activity_updated", { type: "tags" });
            } else {
                socketService.notifyUser(item.targetId, "notification", item.payload);
                socketService.notifyUser(item.targetId, "activity_updated", { type: "tags" });
            }
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

            UNION ALL

            SELECT
                o.org_id AS id,
                o.name AS full_name,
                o.slug AS account_name,
                o.headline AS headline,
                o.logo_url AS avatar_url,
                NULL::text AS account_type,
                'COMPANY'::text as type,
                o.slug as slug,
                o.industry as industry,
                pt.tag_id,
                pt.updated_at AS tagged_at
            FROM post_tags pt
            JOIN organizations o ON pt.tagged_user_id = o.org_id
            WHERE pt.post_id = $1 AND pt.is_active_tag = true AND o.is_deleted = FALSE

            ORDER BY tagged_at DESC
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
