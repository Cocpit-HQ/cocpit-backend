/**
 * Organisation Profile Controller
 *
 * Implements the public-facing organisation profile tabs:
 *   GET  /organizations/:orgId/profile     — Home tab (overview + own/other view)
 *   GET  /organizations/:orgId/about       — About tab (description, offices, links, specialties)
 *   GET  /organizations/:orgId/team        — Core Team section
 *   GET  /organizations/:orgId/people      — People tab (public member list)
 *   GET  /organizations/:orgId/alumni      — Alumni tab (institutions only)
 *   PUT  /organizations/:orgId/profile     — Update profile details (Step 1)
 *   PUT  /organizations/:orgId/about       — Update about (Step 2)
 *   PUT  /organizations/:orgId/verification  — Update verification details (Step 3)
 *   PATCH /organizations/:orgId/members/:userId/core-team — Manage core team member
 *
 * Reference pattern: profile.controller.js + profile.repository.js
 */

'use strict';

const pool = require('../../core/db/pool');
const { checkOrgPermission } = require('../../core/utils/rbac');
const { logAudit } = require('../../core/infrastructure/audit.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve orgId param — accepts UUID or slug.
 * Returns { org_id, entity_type, ... } or null if not found.
 */
async function resolveOrg(orgIdOrSlug) {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const isUuid = uuidRegex.test(orgIdOrSlug);

    const result = await pool.query(
        `SELECT org_id, name, slug, logo_url, cover_url, headline, slogan,
                industry, size, website, location, phone, email,
                description, entity_type, institution_type,
                established_year, campus_location,
                verification_status, email_verified, phone_verified,
                country, city, created_at, updated_at, created_by
         FROM organizations
         WHERE ${isUuid ? 'org_id = $1::uuid' : 'slug = $1'}
           AND is_deleted = FALSE`,
        [orgIdOrSlug]
    );
    return result.rows[0] || null;
}

/**
 * Check if a user is an ACTIVE member of the org.
 * Returns { role_name, permissions, priority } or null.
 */
async function getViewerMembership(orgId, userId) {
    if (!userId) return null;
    const result = await pool.query(
        `SELECT cr.name AS role_name, cr.permissions, cr.priority
         FROM organization_members cm
         JOIN organization_roles cr ON cm.role_id = cr.role_id
         WHERE cm.org_id = $1
           AND cm.user_id = $2
           AND cm.status = 'ACTIVE'
           AND (cm.expires_at IS NULL OR cm.expires_at > NOW())`,
        [orgId, userId]
    );
    const row = result.rows[0];
    if (row && row.permissions && typeof row.permissions === 'string') {
        try {
            row.permissions = JSON.parse(row.permissions);
        } catch (e) {
            console.error("Failed to parse permissions string:", e);
            row.permissions = [];
        }
    }
    return row || null;
}

// ---------------------------------------------------------------------------
// API 1 — GET /organizations/:orgId/profile
// ---------------------------------------------------------------------------

exports.getOrgProfile = async (req, res) => {
    const { orgId } = req.params;
    const viewerId = req.user?.sub || null;

    try {
        // 1. Resolve org
        const org = await resolveOrg(orgId);
        if (!org) return res.status(404).json({ message: 'Organization not found' });

        // 2. Run all queries in parallel
        const [
            countsResult,
            membershipResult,
            latestPostsResult,
            linksResult,
            keyOfferingsResult,
            growthData,
        ] = await Promise.all([
            // Counts (followers, subscribers, members, posts, active jobs)
            pool.query(
                `SELECT
                    (
                        (SELECT COUNT(*) FROM organization_user_follows WHERE org_id = $1) +
                        (SELECT COUNT(*) FROM organization_org_follows WHERE follower_org_id = $1)
                    )::int AS following_count,
                    (SELECT COUNT(*) FROM organization_followers WHERE org_id = $1)::int AS followers_count,
                    (
                        SELECT COUNT(DISTINCT cs.user_id) 
                        FROM community_subscriptions cs
                        JOIN communities c ON cs.community_id = c.community_id
                        WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED'
                    )::int AS subscribers_count,
                    (
                        SELECT COUNT(DISTINCT p.user_id)
                        FROM experiences e
                        JOIN profiles p ON e.profile_id = p.profile_id
                        WHERE e.org_id = $1::uuid AND (e.is_current = TRUE OR e.end_date IS NULL)
                    )::int AS members_count,
                    (
                        SELECT COUNT(DISTINCT p.user_id)
                        FROM educations ed
                        JOIN profiles p ON ed.profile_id = p.profile_id
                        WHERE ed.school_org_id = $1::uuid
                    )::int AS alumni_count,
                    (SELECT COUNT(*) FROM posts WHERE author_org_id = $1)::int AS posts_count,
                    (SELECT COUNT(*) FROM jobs WHERE org_id = $1 AND status = 'ACTIVE' AND is_active = TRUE)::int AS active_jobs_count`,
                [org.org_id]
            ),
            // Viewer membership check
            getViewerMembership(org.org_id, viewerId),
            // Latest 3 posts preview
            pool.query(
                `SELECT p.post_id, p.content, p.created_at,
                        COALESCE(lc.like_count, 0)::int AS like_count,
                        COALESCE(cc.comment_count, 0)::int AS comment_count,
                        COALESCE(pm.media, '[]'::json) AS media,
                        (
                            SELECT COALESCE(comp_like.slug, u_like.account_name)
                            FROM post_likes pl_sample
                            LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
                            LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
                            WHERE pl_sample.post_id = p.post_id
                            ORDER BY pl_sample.created_at DESC
                            LIMIT 1
                        ) AS sample_liker_username,
                        EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $2) AS is_liked
                 FROM posts p
                 LEFT JOIN (
                     SELECT post_id, COUNT(*)::int AS like_count FROM post_likes GROUP BY post_id
                 ) lc ON lc.post_id = p.post_id
                 LEFT JOIN (
                     SELECT post_id, COUNT(*)::int AS comment_count FROM post_comments GROUP BY post_id
                 ) cc ON cc.post_id = p.post_id
                 LEFT JOIN (
                     SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) AS media
                     FROM post_media GROUP BY post_id
                 ) pm ON pm.post_id = p.post_id
                 WHERE p.author_org_id = $1
                   AND p.is_community_article IS NOT TRUE
                   AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND p.is_active = TRUE
                 ORDER BY p.created_at DESC
                 LIMIT 3`,
                [org.org_id, viewerId || null]
            ),
            // Organization links
            pool.query(
                `SELECT link_id, platform, url, display_label
                 FROM organization_links
                 WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY platform ASC`,
                [org.org_id]
            ),
            // Key offerings (Profile tab — public profile "Key offerings" section)
            pool.query(
                `SELECT offering_id, icon, content
                 FROM organization_key_offerings
                 WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY position ASC`,
                [org.org_id]
            ),
            // Employee growth trend
            calculateEmployeeGrowth(pool, org.org_id),
        ]);

        const counts = countsResult.rows[0];
        const membership = membershipResult; // null if not a member
        const isOwnProfile = !!membership;
        const isOwner = !!(viewerId && org.created_by && viewerId === org.created_by);

        // 3. Core team — always public (visible to all viewers)
        const teamResult = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                    cm.title, cm.description AS member_description,
                    COALESCE(cr.name, cm.role) AS role_display,
                    cr.color AS role_color
             FROM organization_members cm
             JOIN active_users u ON cm.user_id = u.user_id
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1
               AND cm.status = 'ACTIVE'
             ORDER BY cr.priority DESC NULLS LAST, cm.joined_at ASC
             LIMIT 6`,
            [org.org_id]
        );

        // 4. Relationship, Relevance, and Community (now computed dynamically)
        let relationship = {
            is_following: false,
            is_subscribed: false,
            is_connected: false,
        };
        let relevance = {
            connections_who_follow: [],
            mutual_connections_count: 0,
            employee_growth: growthData
        };
        let community = {
            recent_followers: [],
            total_followers: counts.followers_count
        };

        if (isOwner) {
            relationship = {
                is_following: true,
                is_subscribed: true,
                is_connected: true,
            };
        } else if (viewerId) {
            const [relResult, relevanceResult, mutualCountResult] = await Promise.all([
                pool.query(
                    `SELECT
                        EXISTS(SELECT 1 FROM organization_followers WHERE user_id = $1 AND org_id = $2) AS is_following,
                        EXISTS(SELECT 1 FROM community_subscriptions cs JOIN communities c ON cs.community_id = c.community_id WHERE cs.user_id = $1 AND c.org_id = $2 AND cs.status = 'SUBSCRIBED') AS is_subscribed,
                        EXISTS(SELECT 1 FROM organization_connections WHERE user_id = $1 AND org_id = $2) AS is_connected,
                        EXISTS(SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)) AS is_blocked`,
                    [viewerId, org.org_id]
                ),
                pool.query(
                    `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name
                     FROM connections c
                     JOIN active_users u ON c.connected_user_id = u.user_id
                     JOIN organization_followers ofol ON ofol.user_id = u.user_id
                     WHERE c.user_id = $1 AND ofol.org_id = $2
                     LIMIT 5`,
                    [viewerId, org.org_id]
                ),
                pool.query(
                    `SELECT COUNT(*)::int AS count
                     FROM connections c
                     JOIN organization_followers ofol ON ofol.user_id = c.connected_user_id
                     WHERE c.user_id = $1 AND ofol.org_id = $2`,
                    [viewerId, org.org_id]
                )
            ]);

            relationship = {
                is_following: !!relResult.rows[0]?.is_following,
                is_subscribed: !!relResult.rows[0]?.is_subscribed,
                is_connected: !!relResult.rows[0]?.is_connected,
                is_blocked: !!relResult.rows[0]?.is_blocked,
            };

            relevance = {
                connections_who_follow: relevanceResult.rows,
                mutual_connections_count: mutualCountResult.rows[0]?.count || 0,
                employee_growth: growthData
            };
        }

        const recentFollowersResult = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name
             FROM organization_followers ofol
             JOIN active_users u ON ofol.user_id = u.user_id
             WHERE ofol.org_id = $1
             ORDER BY ofol.created_at DESC
             LIMIT 5`,
            [org.org_id]
        );

        community = {
            recent_followers: recentFollowersResult.rows,
            total_followers: counts.followers_count
        };

        const commDbRes = await pool.query(
            `SELECT c.community_id, c.name, c.banner_url, c.description,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count,
                    COALESCE(
                        EXISTS(
                            SELECT 1 FROM community_subscriptions 
                            WHERE user_id = $2 AND community_id = c.community_id AND status = 'SUBSCRIBED'
                        ), FALSE
                    ) AS is_subscribed
             FROM communities c
             WHERE c.org_id = $1 AND c.is_active = TRUE
             ORDER BY c.created_at DESC`,
            [org.org_id, viewerId]
        );
        const communityDetails = commDbRes.rowCount > 0 ? {
            exists: true,
            community_id: commDbRes.rows[0].community_id,
            name: commDbRes.rows[0].name,
            banner_url: commDbRes.rows[0].banner_url,
            description: commDbRes.rows[0].description,
            is_subscribed: commDbRes.rows[0].is_subscribed,
            subscriber_count: commDbRes.rows[0].subscriber_count,
            is_owner: isOwner
        } : null;

        const peopleQuery = org.entity_type === 'INSTITUTION'
            ? `WITH school_alumni AS (
                   SELECT DISTINCT ON (p.user_id)
                          u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                          u.location,
                          COALESCE(EXTRACT(YEAR FROM ed.end_date)::int, 0) AS graduation_year,
                          ed.field_of_study
                   FROM educations ed
                   JOIN profiles p ON ed.profile_id = p.profile_id
                   JOIN active_users u ON p.user_id = u.user_id
                   WHERE ed.school_org_id = $1::uuid
                   ORDER BY p.user_id, ed.end_date DESC
               )
               SELECT *,
                      COALESCE(
                          CASE WHEN $2::uuid IS NULL THEN false
                               ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = $2::uuid AND following_id = user_id)
                          END, false
                      ) AS is_following,
                      COALESCE(
                          CASE WHEN $2::uuid IS NULL THEN false
                               ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = user_id AND following_id = $2::uuid)
                          END, false
                      ) AS is_followed_by,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          WHEN EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $2::uuid AND c.connected_user_id = school_alumni.user_id) THEN 'connected'
                          ELSE (SELECT status FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_status,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          ELSE (SELECT request_id FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_id,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          ELSE (SELECT CASE WHEN sender_id = $2::uuid THEN 'me' ELSE 'them' END FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_sender
               FROM school_alumni
               ORDER BY graduation_year DESC, user_id ASC
               LIMIT 5`
            : `WITH current_employees AS (
                   SELECT DISTINCT ON (p.user_id)
                          u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                          u.location,
                          e.title,
                          COALESCE(e.start_date, '1970-01-01') AS joined_at
                   FROM experiences e
                   JOIN profiles p ON e.profile_id = p.profile_id
                   JOIN active_users u ON p.user_id = u.user_id
                   WHERE e.org_id = $1::uuid
                     AND (e.is_current = TRUE OR e.end_date IS NULL)
                   ORDER BY p.user_id, e.start_date DESC
               )
               SELECT *,
                      COALESCE(
                          CASE WHEN $2::uuid IS NULL THEN false
                               ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = $2::uuid AND following_id = user_id)
                          END, false
                      ) AS is_following,
                      COALESCE(
                          CASE WHEN $2::uuid IS NULL THEN false
                               ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = user_id AND following_id = $2::uuid)
                          END, false
                      ) AS is_followed_by,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          WHEN EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $2::uuid AND c.connected_user_id = current_employees.user_id) THEN 'connected'
                          ELSE (SELECT status FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_status,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          ELSE (SELECT request_id FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_id,
                      CASE 
                          WHEN $2::uuid IS NULL THEN null
                          ELSE (SELECT CASE WHEN sender_id = $2::uuid THEN 'me' ELSE 'them' END FROM connection_requests WHERE ((sender_id = $2::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $2::uuid)) AND status != 'connected' LIMIT 1)
                      END AS connection_request_sender
               FROM current_employees
               ORDER BY joined_at DESC, user_id ASC
               LIMIT 5`;

        const peopleResult = await pool.query(peopleQuery, [org.org_id, viewerId]);
        const peopleRows = peopleResult.rows.map(r => ({
            ...r,
            is_connection: !!(r.is_following && r.is_followed_by)
        }));

        // Log public profile view only when an external user (non-member) views the org profile
        if (viewerId && !isOwnProfile) {
            logAudit(pool, {
                entityId: org.org_id,
                actorId: viewerId,
                actorRole: membership?.role_name || null,
                action: 'VIEW',
                metadata: { source: 'public_profile', orgName: org.name }
            }).catch(err => console.error("Profile view audit log error:", err));
        }

        return res.json({
            org: {
                ...org,
                is_verified: ['DOMAIN_VERIFIED'].includes(org.verification_status),
                following_count: counts.following_count || 0,
                followers_count: counts.followers_count,
                subscribers_count: counts.subscribers_count || 0,
                members_count: org.entity_type === 'INSTITUTION' ? counts.alumni_count : counts.members_count,
                posts_count: counts.posts_count,
                active_jobs_count: counts.active_jobs_count,
                owner_id: org.created_by,
                key_offerings: keyOfferingsResult.rows.map(r => ({ id: r.offering_id, icon: r.icon, label: r.label, content: r.content })),
            },
            is_own_profile: isOwner,
            viewer_role: membership?.role_name || null,
            viewer_permissions: membership?.permissions || null,
            about_snippet: org.description ? org.description.slice(0, 250) : null,
            core_team: teamResult.rows,
            latest_posts: latestPostsResult.rows,
            links: linksResult.rows,
            owner_id: org.created_by,
            is_following: relationship.is_following,
            is_subscribed: relationship.is_subscribed,
            is_connected: relationship.is_connected,
            relationship,
            relevance,
            community,
            community_details: communityDetails,
            communities: commDbRes.rows,
            people: peopleRows,
        });

    } catch (err) {
        console.error('getOrgProfile error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// ---------------------------------------------------------------------------
// API 2 — GET /organizations/:orgId/about
// ---------------------------------------------------------------------------

exports.getOrgAbout = async (req, res) => {
    const { orgId } = req.params;
    const viewerId = req.user?.sub || null;

    try {
        const org = await resolveOrg(orgId);
        if (!org) return res.status(404).json({ message: 'Organization not found' });

        // Viewer membership (to decide if sensitive fields exposed)
        const membership = await getViewerMembership(org.org_id, viewerId);
        const isOwnProfile = !!membership;

        const [officesResult, linksResult, specialtiesResult] = await Promise.all([
            pool.query(
                `SELECT office_id, city, country, address, is_headquarters
                 FROM organization_offices 
                 WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY is_headquarters DESC, city ASC`,
                [org.org_id]
            ),
            pool.query(
                `SELECT link_id, platform, url, display_label
                 FROM organization_links 
                 WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY platform ASC`,
                [org.org_id]
            ),
            pool.query(
                `SELECT specialty_id, name
                 FROM organization_specialties 
                 WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY name ASC`,
                [org.org_id]
            ),
        ]);

        const about = {
            description: org.description,
            slogan: org.slogan,
            website: org.website,
            industry: org.industry,
            size: org.size,
            location: org.location,
            country: org.country,
            city: org.city,
            founded: org.established_year,
            entity_type: org.entity_type,
            institution_type: org.institution_type,
            campus_location: org.campus_location,
            headline: org.headline,
        };

        // Sensitive fields exposed only to members
        if (isOwnProfile) {
            about.phone = org.phone;
            about.email = org.email;
            about.phone_verified = org.phone_verified;
            about.email_verified = org.email_verified;
            about.verification_status = org.verification_status;
        }

        return res.json({
            about,
            offices: officesResult.rows,
            links: linksResult.rows,
            specialties: specialtiesResult.rows,
        });

    } catch (err) {
        console.error('getOrgAbout error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// ---------------------------------------------------------------------------
// API 3 — GET /organizations/:orgId/team
// ---------------------------------------------------------------------------

exports.getOrgTeam = async (req, res) => {
    const { orgId } = req.params;

    try {
        const org = await resolveOrg(orgId);
        if (!org) return res.status(404).json({ message: 'Organization not found' });

        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                    cm.title, cm.description AS member_description,
                    COALESCE(cr.name, cm.role) AS role_display,
                    cr.color AS role_color,
                    cm.joined_at
             FROM organization_members cm
             JOIN active_users u ON cm.user_id = u.user_id
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1
               AND cm.status = 'ACTIVE'
             ORDER BY cr.priority DESC NULLS LAST, cm.joined_at ASC`,
            [org.org_id]
        );
        return res.json({ team: result.rows });

    } catch (err) {
        console.error('getOrgTeam error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

async function getViewerMembership(orgId, userId) {
    if (!userId) return null;
    const result = await pool.query(
        `SELECT cr.name AS role_name, cr.permissions, cr.priority
         FROM organization_members cm
         JOIN organization_roles cr ON cm.role_id = cr.role_id
         WHERE cm.org_id = $1
           AND cm.user_id = $2
           AND cm.status = 'ACTIVE'
           AND (cm.expires_at IS NULL OR cm.expires_at > NOW())`,
        [orgId, userId]
    );
    const row = result.rows[0];
    if (row && row.permissions && typeof row.permissions === 'string') {
        try {
            row.permissions = JSON.parse(row.permissions);
        } catch (e) {
            console.error("Failed to parse permissions string:", e);
            row.permissions = [];
        }
    }
    return row || null;
}

/**
 * Calculate demographics insights (Locations, Skills, Roles, Education) for matching members/alumni.
 * Filters by active status and visibility parameters to match visible list.
 */
async function calculateOrgDemographics(client, orgId, type, search, graduationYear) {
    const searchVal = (search && search.trim()) ? `%${search.trim()}%` : null;
    const graduationYearVal = graduationYear ? parseInt(graduationYear) : null;

    const params = type === 'PEOPLE' ? [orgId, searchVal] : [orgId, searchVal, graduationYearVal];

    const cteQuery = type === 'PEOPLE'
        ? `SELECT DISTINCT ON (p.user_id) p.user_id
           FROM experiences e
           JOIN profiles p ON e.profile_id = p.profile_id
           JOIN active_users u ON p.user_id = u.user_id
           WHERE e.org_id = $1::uuid
             AND (e.is_current = TRUE OR e.end_date IS NULL)
             AND ($2::text IS NULL OR (u.full_name ILIKE $2::text OR e.title ILIKE $2::text))`
        : `SELECT DISTINCT ON (p.user_id) p.user_id
           FROM educations ed
           JOIN profiles p ON ed.profile_id = p.profile_id
           JOIN active_users u ON p.user_id = u.user_id
           WHERE ed.school_org_id = $1::uuid
             AND ($2::text IS NULL OR u.full_name ILIKE $2::text)
             AND ($3::int IS NULL OR EXTRACT(YEAR FROM ed.end_date)::int = $3::int)`;

    // Get matching users count
    const countRes = await client.query(`
        WITH matching_users AS (${cteQuery})
        SELECT COUNT(*)::int AS count FROM matching_users
    `, params);
    
    const totalAssociates = countRes.rows[0]?.count || 0;

    if (totalAssociates === 0) {
        return {
            totalAssociates: 0,
            locationDistribution: [],
            topSkills: [],
            roleDistribution: [],
            educationBreakdown: []
        };
    }

    const limitClause = (search && search.trim()) ? 'LIMIT 5' : ''; // show top 5 when searching, all on initial load

    // A. Location Distribution
    const locationRes = await client.query(`
        WITH matching_users AS (${cteQuery})
        SELECT 
            COALESCE(NULLIF(TRIM(u.location_city), ''), 'Unknown') AS name,
            COUNT(*)::int AS count
        FROM matching_users mu
        JOIN active_users u ON mu.user_id = u.user_id
        GROUP BY u.location_city
        ORDER BY count DESC
        ${limitClause}
    `, params);

    // B. Top Skills
    const skillsRes = await client.query(`
        WITH matching_users AS (${cteQuery})
        SELECT 
            s.name AS name,
            COUNT(DISTINCT mu.user_id)::int AS count
        FROM matching_users mu
        JOIN profiles p ON mu.user_id = p.user_id
        JOIN user_skills us ON p.profile_id = us.profile_id
        JOIN skills s ON us.skill_id = s.skill_id
        GROUP BY s.name
        ORDER BY count DESC
        ${limitClause}
    `, params);

    // C. Role Distribution
    const roleRes = await client.query(`
        WITH matching_users AS (${cteQuery}),
        user_roles AS (
            SELECT mu.user_id,
                   (SELECT e.title 
                    FROM experiences e
                    JOIN profiles p ON e.profile_id = p.profile_id
                    WHERE p.user_id = mu.user_id
                    ORDER BY e.start_date DESC, e.created_at DESC 
                    LIMIT 1) AS last_role
            FROM matching_users mu
        )
        SELECT 
            COALESCE(NULLIF(TRIM(last_role), ''), 'Other') AS name,
            COUNT(*)::int AS count
        FROM user_roles
        GROUP BY name
        ORDER BY count DESC
        ${limitClause}
    `, params);

    // D. Education Breakdown
    const eduRes = await client.query(`
        WITH matching_users AS (${cteQuery})
        SELECT 
            COALESCE(NULLIF(TRIM(e.school_name), ''), 'Unknown') AS name,
            COUNT(DISTINCT mu.user_id)::int AS count
        FROM matching_users mu
        JOIN profiles p ON mu.user_id = p.user_id
        JOIN educations e ON p.profile_id = e.profile_id
        GROUP BY e.school_name
        ORDER BY count DESC
        ${limitClause}
    `, params);

    const formatDistribution = (rows) => {
        return rows.map(row => ({
            name: row.name,
            percentage: Math.round((row.count * 100) / totalAssociates)
        }));
    };

    return {
        totalAssociates,
        locationDistribution: formatDistribution(locationRes.rows),
        topSkills: formatDistribution(skillsRes.rows),
        roleDistribution: formatDistribution(roleRes.rows),
        educationBreakdown: formatDistribution(eduRes.rows)
    };
}

// ---------------------------------------------------------------------------
// API 6 — GET /organizations/:orgId/people
// ---------------------------------------------------------------------------

exports.getOrgPeople = async (req, res) => {
    const { orgId } = req.params;
    const { limit = 20, search, cursor } = req.query;
    const limitVal = parseInt(limit);
    const viewerId = req.user?.sub || null;

    try {
        const org = await resolveOrg(orgId);
        if (!org) return res.status(404).json({ message: 'Organization not found' });

        let cursorIsConnected = null;
        let cursorJoinedAt = null;
        let cursorUserId = null;
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, 'base64').toString('ascii');
                const parts = decoded.split('|');
                if (parts.length === 3) {
                    cursorIsConnected = parts[0] === '1';
                    cursorJoinedAt = parts[1];
                    cursorUserId = parts[2];
                }
            } catch (_) { /* invalid cursor — ignore */ }
        }

        const params = [org.org_id, limitVal, viewerId];
        let searchClause = '';
        if (search && search.trim()) {
            params.push(`%${search.trim()}%`);
            searchClause = `AND (u.full_name ILIKE $${params.length} OR e.title ILIKE $${params.length})`;
        }

        let cursorClause = '';
        if (cursorIsConnected !== null && cursorJoinedAt && cursorUserId) {
            params.push(cursorIsConnected, cursorJoinedAt, cursorUserId);
            const pIsConnected = params.length - 2;
            const pJoinedAt = params.length - 1;
            const pUserId = params.length;
            cursorClause = `AND (
                (sub.connection_request_status = 'connected') < $${pIsConnected}::boolean
                OR ((sub.connection_request_status = 'connected') = $${pIsConnected}::boolean AND sub.joined_at < $${pJoinedAt}::date)
                OR ((sub.connection_request_status = 'connected') = $${pIsConnected}::boolean AND sub.joined_at = $${pJoinedAt}::date AND sub.user_id > $${pUserId}::uuid)
            )`;
        }

        const countParams = [org.org_id, viewerId];
        let countSearchClause = '';
        if (search && search.trim()) {
            countParams.push(`%${search.trim()}%`);
            countSearchClause = `AND (u.full_name ILIKE $${countParams.length} OR e.title ILIKE $${countParams.length})`;
        }

        const [peopleResult, countResult, insights] = await Promise.all([
            pool.query(
                `WITH current_employees AS (
                     SELECT DISTINCT ON (p.user_id)
                            u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                            u.location,
                            e.title,
                            e.title AS role_display,
                            NULL AS role_color,
                            FALSE AS is_core_team,
                            COALESCE(e.start_date, '1970-01-01') AS joined_at
                     FROM experiences e
                     JOIN profiles p ON e.profile_id = p.profile_id
                     JOIN active_users u ON p.user_id = u.user_id
                     WHERE e.org_id = $1::uuid
                       AND (e.is_current = TRUE OR e.end_date IS NULL)
                       ${searchClause}
                     ORDER BY p.user_id, e.start_date DESC
                 ),
                 enriched AS (
                     SELECT *,
                            COALESCE(
                                CASE WHEN $3::uuid IS NULL THEN false
                                     ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = $3::uuid AND following_id = user_id)
                                END, false
                            ) AS is_following,
                            COALESCE(
                                CASE WHEN $3::uuid IS NULL THEN false
                                     ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = user_id AND following_id = $3::uuid)
                                END, false
                            ) AS is_followed_by,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                WHEN EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $3::uuid AND c.connected_user_id = current_employees.user_id) THEN 'connected'
                                ELSE (SELECT status FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_status,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                ELSE (SELECT request_id FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_id,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                ELSE (SELECT CASE WHEN sender_id = $3::uuid THEN 'me' ELSE 'them' END FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_sender
                     FROM current_employees
                 )
                 SELECT * FROM enriched sub
                 WHERE 1=1
                   ${cursorClause}
                 ORDER BY (sub.connection_request_status = 'connected') DESC NULLS LAST, sub.joined_at DESC, sub.user_id ASC
                 LIMIT $2`,
                params
            ),
            pool.query(
                `WITH current_employees AS (
                     SELECT DISTINCT ON (p.user_id) p.user_id
                     FROM experiences e
                     JOIN profiles p ON e.profile_id = p.profile_id
                     JOIN active_users u ON p.user_id = u.user_id
                     WHERE e.org_id = $1::uuid
                       AND (e.is_current = TRUE OR e.end_date IS NULL)
                       ${countSearchClause}
                 )
                 SELECT
                     COUNT(*)::int AS total,
                     COUNT(*) FILTER (
                         WHERE $2::uuid IS NOT NULL
                           AND (
                               EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $2::uuid AND c.connected_user_id = current_employees.user_id)
                           )
                     )::int AS connections_total
                 FROM current_employees`,
                countParams
            ),
            calculateOrgDemographics(pool, org.org_id, 'PEOPLE', search)
        ]);

        const rows = peopleResult.rows.map(r => ({
            ...r,
            is_connection: !!(r.is_following && r.is_followed_by),
            is_connected: r.connection_request_status === 'connected'
        }));
        let nextCursor = null;
        if (rows.length === limitVal && limitVal > 0) {
            const lastItem = rows[rows.length - 1];
            const lastJoinedAt = lastItem.joined_at ? new Date(lastItem.joined_at).toISOString().split('T')[0] : '1970-01-01';
            const lastIsConnected = lastItem.is_connected ? '1' : '0';
            nextCursor = Buffer.from(`${lastIsConnected}|${lastJoinedAt}|${lastItem.user_id}`).toString('base64');
        }

        const total = countResult.rows[0].total;
        const connectionsTotal = countResult.rows[0].connections_total || 0;

        return res.json({
            people: rows,
            meta: {
                total,
                connections_total: connectionsTotal,
                limit: limitVal,
                next_cursor: nextCursor,
                has_more: !!nextCursor
            },
            insights
        });

    } catch (err) {
        console.error('getOrgPeople error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// ---------------------------------------------------------------------------
// API 7 — GET /organizations/:orgId/alumni  (institutions only)
// ---------------------------------------------------------------------------

exports.getOrgAlumni = async (req, res) => {
    const { orgId } = req.params;
    const { limit = 20, search, graduation_year, cursor } = req.query;
    const limitVal = parseInt(limit);
    const viewerId = req.user?.sub || null;

    try {
        const org = await resolveOrg(orgId);
        if (!org) return res.status(404).json({ message: 'Organization not found' });

        if (org.entity_type !== 'INSTITUTION') {
            return res.status(404).json({ message: 'Alumni tab is only available for institutions' });
        }

        let cursorIsConnected = null;
        let cursorGradYear = null;
        let cursorUserId = null;
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, 'base64').toString('ascii');
                const parts = decoded.split('|');
                if (parts.length === 3) {
                    cursorIsConnected = parts[0] === '1';
                    cursorGradYear = parseInt(parts[1]);
                    cursorUserId = parts[2];
                }
            } catch (_) { /* invalid cursor — ignore */ }
        }

        const params = [org.org_id, limitVal, viewerId];
        const filters = [];

        if (search && search.trim()) {
            params.push(`%${search.trim()}%`);
            filters.push(`u.full_name ILIKE $${params.length}`);
        }
        if (graduation_year) {
            params.push(parseInt(graduation_year));
            filters.push(`EXTRACT(YEAR FROM ed.end_date)::int = $${params.length}`);
        }

        let cursorClause = '';
        if (cursorIsConnected !== null && cursorGradYear !== null && cursorUserId) {
            params.push(cursorIsConnected, cursorGradYear, cursorUserId);
            const pIsConnected = params.length - 2;
            const pGradYear = params.length - 1;
            const pUserId = params.length;
            cursorClause = `AND (
                (sub.connection_request_status = 'connected') < $${pIsConnected}::boolean
                OR ((sub.connection_request_status = 'connected') = $${pIsConnected}::boolean AND sub.graduation_year < $${pGradYear})
                OR ((sub.connection_request_status = 'connected') = $${pIsConnected}::boolean AND sub.graduation_year = $${pGradYear} AND sub.user_id > $${pUserId}::uuid)
            )`;
        }

        const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

        // Extract raw query filters for total/insights counts
        const countParams = [org.org_id, viewerId];
        const countFilters = [];
        if (search && search.trim()) {
            countParams.push(`%${search.trim()}%`);
            countFilters.push(`u.full_name ILIKE $${countParams.length}`);
        }
        if (graduation_year) {
            countParams.push(parseInt(graduation_year));
            countFilters.push(`EXTRACT(YEAR FROM ed.end_date)::int = $${countParams.length}`);
        }
        const countWhereExtra = countFilters.length ? `AND ${countFilters.join(' AND ')}` : '';

        const [alumniResult, countResult, insights] = await Promise.all([
            pool.query(
                `WITH school_alumni AS (
                     SELECT DISTINCT ON (p.user_id)
                            u.user_id, u.full_name, u.avatar_url, u.headline, u.account_name,
                            u.location,
                            COALESCE(EXTRACT(YEAR FROM ed.end_date)::int, 0) AS graduation_year,
                            ed.field_of_study,
                            -- Latest current experience
                            (SELECT e.title
                             FROM experiences e
                             JOIN profiles p2 ON e.profile_id = p2.profile_id
                             WHERE p2.user_id = u.user_id AND e.is_current = TRUE
                             ORDER BY e.start_date DESC LIMIT 1) AS current_title,
                            (SELECT e.company_name
                             FROM experiences e
                             JOIN profiles p2 ON e.profile_id = p2.profile_id
                             WHERE p2.user_id = u.user_id AND e.is_current = TRUE
                             ORDER BY e.start_date DESC LIMIT 1) AS current_company
                     FROM educations ed
                     JOIN profiles p ON ed.profile_id = p.profile_id
                     JOIN active_users u ON p.user_id = u.user_id
                     WHERE ed.school_org_id = $1::uuid
                       ${whereExtra}
                     ORDER BY p.user_id, ed.end_date DESC
                 ),
                 enriched AS (
                     SELECT *,
                            COALESCE(
                                CASE WHEN $3::uuid IS NULL THEN false
                                     ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = $3::uuid AND following_id = user_id)
                                END, false
                            ) AS is_following,
                            COALESCE(
                                CASE WHEN $3::uuid IS NULL THEN false
                                     ELSE EXISTS(SELECT 1 FROM followers WHERE follower_id = user_id AND following_id = $3::uuid)
                                END, false
                            ) AS is_followed_by,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                WHEN EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $3::uuid AND c.connected_user_id = school_alumni.user_id) THEN 'connected'
                                ELSE (SELECT status FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_status,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                ELSE (SELECT request_id FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_id,
                            CASE
                                WHEN $3::uuid IS NULL THEN null
                                ELSE (SELECT CASE WHEN sender_id = $3::uuid THEN 'me' ELSE 'them' END FROM connection_requests WHERE ((sender_id = $3::uuid AND receiver_id = user_id) OR (sender_id = user_id AND receiver_id = $3::uuid)) AND status != 'connected' LIMIT 1)
                            END AS connection_request_sender
                     FROM school_alumni
                 )
                 SELECT * FROM enriched sub
                 WHERE 1=1
                   ${cursorClause}
                 ORDER BY (sub.connection_request_status = 'connected') DESC NULLS LAST, sub.graduation_year DESC, sub.user_id ASC
                 LIMIT $2`,
                params
            ),
            pool.query(
                `WITH school_alumni AS (
                     SELECT DISTINCT ON (p.user_id) p.user_id
                     FROM educations ed
                     JOIN profiles p ON ed.profile_id = p.profile_id
                     JOIN active_users u ON p.user_id = u.user_id
                     WHERE ed.school_org_id = $1::uuid
                       ${countWhereExtra}
                 )
                 SELECT
                     COUNT(*)::int AS total,
                     COUNT(*) FILTER (
                         WHERE $2::uuid IS NOT NULL
                           AND (
                               EXISTS(SELECT 1 FROM connections c WHERE c.user_id = $2::uuid AND c.connected_user_id = school_alumni.user_id)
                           )
                     )::int AS connections_total
                 FROM school_alumni`,
                countParams
            ),
            calculateOrgDemographics(pool, org.org_id, 'ALUMNI', search, graduation_year)
        ]);

        const rows = alumniResult.rows.map(r => ({
            ...r,
            is_connection: !!(r.is_following && r.is_followed_by),
            is_connected: r.connection_request_status === 'connected'
        }));
        let nextCursor = null;
        if (rows.length === limitVal && limitVal > 0) {
            const lastItem = rows[rows.length - 1];
            const lastGradYear = lastItem.graduation_year !== null && lastItem.graduation_year !== undefined ? lastItem.graduation_year : 0;
            const lastIsConnected = lastItem.is_connected ? '1' : '0';
            nextCursor = Buffer.from(`${lastIsConnected}|${lastGradYear}|${lastItem.user_id}`).toString('base64');
        }

        const total = countResult.rows[0].total;
        const connectionsTotal = countResult.rows[0].connections_total || 0;

        return res.json({
            alumni: rows,
            meta: {
                total,
                connections_total: connectionsTotal,
                limit: limitVal,
                next_cursor: nextCursor,
                has_more: !!nextCursor
            },
            insights
        });

    } catch (err) {
        console.error('getOrgAlumni error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// ---------------------------------------------------------------------------
// API 8 — PUT /organizations/:orgId/profile  (Update Step 1 — profile details)
// ---------------------------------------------------------------------------

exports.updateOrgProfile = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const {
        name, headline, industry, size, website, country, city, established_year, keyOfferings
    } = req.body;

    // Validate name if provided
    if (name !== undefined && (!name || name.trim().length < 2)) {
        return res.status(400).json({ message: 'Organization name must be at least 2 characters' });
    }
    // Validate headline length
    if (headline !== undefined && headline !== null && headline.trim().length > 120) {
        return res.status(400).json({ message: 'Headline must be 120 characters or less' });
    }
    // Validate website format (basic)
    if (website && !/^https?:\/\/.+/.test(website)) {
        return res.status(400).json({ message: 'Website must be a valid URL starting with http:// or https://' });
    }
    // Validate keyOfferings if provided
    if (keyOfferings !== undefined && !Array.isArray(keyOfferings)) {
        return res.status(400).json({ message: 'keyOfferings must be an array of objects' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Permission check
        const canEdit = await checkOrgPermission(client, orgId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) {
            throw Object.assign(new Error('Forbidden: You do not have permission to update organization details'), { statusCode: 403 });
        }

        // Build dynamic update to only touch fields defined for Step 1 Profile updates
        const updates = [];
        const params = [];
        const addUpdate = (col, val) => {
            if (val !== undefined) {
                params.push(val);
                updates.push(`${col} = $${params.length}`);
            }
        };

        addUpdate('name', name?.trim() || null);
        addUpdate('headline', headline?.trim() || null);
        addUpdate('industry', industry || null);
        addUpdate('size', size || null);
        addUpdate('website', website?.trim() || null);
        addUpdate('country', country?.trim() || null);
        addUpdate('city', city?.trim() || null);
        addUpdate('established_year', established_year ? parseInt(established_year) : null);

        if (params.length === 0 && keyOfferings === undefined) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'No fields to update' });
        }

        let result;
        if (params.length > 0) {
            params.push(orgId);
            const query = `
                UPDATE organizations
                SET ${updates.join(', ')}, updated_at = NOW()
                WHERE org_id = $${params.length} AND is_deleted = FALSE
                RETURNING org_id, name, headline, industry, size, website,
                          country, city, established_year, logo_url, cover_url,
                          entity_type, updated_at
            `;
            result = await client.query(query, params);
        } else {
            result = await client.query(
                `SELECT org_id, name, headline, industry, size, website,
                        country, city, established_year, logo_url, cover_url,
                        entity_type, updated_at
                 FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );
        }

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Organization not found' });
        }

        // Sync key offerings (child table, ordered list — full replace keeps display order intact)
        let cleanOfferings; // undefined when keyOfferings wasn't part of this update
        if (keyOfferings !== undefined) {
            const KEY_OFFERING_ICONS_MAP = {
                "iconoir:rocket": "Rocket",
                "iconoir:globe": "Globe",
                "lucide:trending-up": "Trending Up",
                "lucide:folder-tree": "Folder Tree",
                "iconoir:lightbulb": "Lightbulb",
                "lucide:shield-check": "Shield Check",
                "lucide:settings": "Settings",
                "iconoir:tools": "Tools",
                "iconoir:leaf": "Leaf",
                "lucide:handshake": "Handshake"
            };

            for (let i = 0; i < keyOfferings.length; i++) {
                const off = keyOfferings[i];
                if (!off.content || !off.content.trim()) continue; // will be filtered out anyway

                const icon = (off.icon || '').trim();
                const label = (off.label || '').trim();
                
                if (!KEY_OFFERING_ICONS_MAP[icon]) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Invalid icon '${icon}' provided for Key Offerings.` });
                }
                
                if (KEY_OFFERING_ICONS_MAP[icon] !== label) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Invalid label '${label}' for icon '${icon}'. Expected label is '${KEY_OFFERING_ICONS_MAP[icon]}'.` });
                }
            }

            await client.query(
                `UPDATE organization_key_offerings SET is_deleted = TRUE WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );

            cleanOfferings = keyOfferings
                .map(off => ({
                    icon: (off.icon || '').trim(),
                    label: (off.label || '').trim(),
                    content: (off.content || '').trim()
                }))
                .filter(off => off.content); // require at least content

            for (let i = 0; i < cleanOfferings.length; i++) {
                await client.query(
                    `INSERT INTO organization_key_offerings (org_id, icon, label, content, position) VALUES ($1, $2, $3, $4, $5)`,
                    [orgId, cleanOfferings[i].icon, cleanOfferings[i].label, cleanOfferings[i].content, i]
                );
            }
        }

        // Audit log
        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
             VALUES ('ORGANIZATION', $1, $2, 'UPDATE_PROFILE_DETAILS', $3)`,
            [orgId, userId, JSON.stringify({ fields: Object.keys(req.body) })]
        );

        await client.query('COMMIT');

        // Return the authoritative saved state (incl. key_offerings) so the client
        // can update its cache directly from this response instead of refetching.
        const organization = result.rows[0];
        if (cleanOfferings !== undefined) {
            organization.key_offerings = cleanOfferings;
        }

        return res.json({ message: 'Profile updated successfully', organization });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('updateOrgProfile error:', err);
        if (err.statusCode === 403) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// API 9 — PUT /organizations/:orgId/about  (Update Step 2 — about)
// ---------------------------------------------------------------------------

exports.updateOrgAbout = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    const { description, slogan, offices, links, specialties } = req.body;

    // Basic validations
    if (description !== undefined && description !== null && description.length > 5000) {
        return res.status(400).json({ message: 'Description must be 5000 characters or less' });
    }
    if (slogan !== undefined && slogan !== null && slogan.length > 255) {
        return res.status(400).json({ message: 'Slogan must be 255 characters or less' });
    }
    if (offices && !Array.isArray(offices)) {
        return res.status(400).json({ message: 'offices must be an array' });
    }
    if (links && !Array.isArray(links)) {
        return res.status(400).json({ message: 'links must be an array' });
    }
    if (specialties && !Array.isArray(specialties)) {
        return res.status(400).json({ message: 'specialties must be an array' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Permission check
        const canEdit = await checkOrgPermission(client, orgId, userId, 'MANAGE_COMPANY_DETAILS');
        if (!canEdit) {
            throw Object.assign(new Error('Forbidden: You do not have permission to update about section'), { statusCode: 403 });
        }

        // Verify org exists
        const orgCheck = await client.query(
            'SELECT org_id FROM organizations WHERE org_id = $1 AND is_deleted = FALSE',
            [orgId]
        );
        if (orgCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Organization not found' });
        }

        // 1. Update description & slogan dynamically
        const updates = [];
        const params = [];
        if (description !== undefined) {
            params.push(description || null);
            updates.push(`description = $${params.length}`);
        }
        if (slogan !== undefined) {
            params.push(slogan || null);
            updates.push(`slogan = $${params.length}`);
        }

        if (updates.length > 0) {
            params.push(orgId);
            await client.query(
                `UPDATE organizations
                 SET ${updates.join(', ')}, updated_at = NOW()
                 WHERE org_id = $${params.length}`,
                params
            );
        }

        // 2. Sync offices with soft deletes
        if (offices !== undefined) {
            // Get all current active office IDs
            const currentRes = await client.query(
                `SELECT office_id FROM organization_offices WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );
            const existingOfficeIds = new Set(currentRes.rows.map(r => r.office_id));

            for (const office of offices) {
                if (!office.city || !office.country) continue;
                const cleanAddress = office.address ? office.address.trim() : '';
                
                if (office.office_id && existingOfficeIds.has(office.office_id)) {
                    // Update existing active office
                    await client.query(
                        `UPDATE organization_offices 
                         SET city = $1, country = $2, address = $3, is_headquarters = $4, is_deleted = FALSE 
                         WHERE office_id = $5`,
                        [office.city.trim(), office.country.trim(), cleanAddress, !!office.is_headquarters, office.office_id]
                    );
                    existingOfficeIds.delete(office.office_id);
                } else {
                    // Insert new office
                    await client.query(
                        `INSERT INTO organization_offices (org_id, city, country, address, is_headquarters)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [orgId, office.city.trim(), office.country.trim(), cleanAddress, !!office.is_headquarters]
                    );
                }
            }

            // Inactive (soft delete) remaining ones
            if (existingOfficeIds.size > 0) {
                await client.query(
                    `UPDATE organization_offices SET is_deleted = TRUE WHERE office_id = ANY($1::uuid[])`,
                    [Array.from(existingOfficeIds)]
                );
            }
        }

        // 3. Sync links with soft deletes
        if (links !== undefined) {
            // Get all current active link IDs
            const currentRes = await client.query(
                `SELECT link_id FROM organization_links WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );
            const existingLinkIds = new Set(currentRes.rows.map(r => r.link_id));
            const VALID_PLATFORMS = ['linkedin', 'twitter', 'instagram', 'facebook', 'youtube', 'discord', 'github', 'other'];

            for (const link of links) {
                if (!link.url) continue;
                const platform = VALID_PLATFORMS.includes(link.platform) ? link.platform : 'other';

                if (link.link_id && existingLinkIds.has(link.link_id)) {
                    // Update existing active link
                    await client.query(
                        `UPDATE organization_links 
                         SET platform = $1, url = $2, display_label = $3, is_deleted = FALSE 
                         WHERE link_id = $4`,
                        [platform, link.url.trim(), link.display_label?.trim() || null, link.link_id]
                    );
                    existingLinkIds.delete(link.link_id);
                } else {
                    // Insert new link
                    await client.query(
                        `INSERT INTO organization_links (org_id, platform, url, display_label)
                         VALUES ($1, $2, $3, $4)`,
                        [orgId, platform, link.url.trim(), link.display_label?.trim() || null]
                    );
                }
            }

            // Inactive (soft delete) remaining ones
            if (existingLinkIds.size > 0) {
                await client.query(
                    `UPDATE organization_links SET is_deleted = TRUE WHERE link_id = ANY($1::uuid[])`,
                    [Array.from(existingLinkIds)]
                );
            }
        }

        // 4. Sync specialties with soft deletes
        if (specialties !== undefined) {
            // Get all current active specialties
            const currentRes = await client.query(
                `SELECT specialty_id, name FROM organization_specialties WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );
            const activeSpecialties = new Map(currentRes.rows.map(r => [r.name.toLowerCase(), r.specialty_id]));

            for (const name of specialties) {
                if (!name || !name.trim()) continue;
                const cleanName = name.trim();
                const key = cleanName.toLowerCase();

                if (activeSpecialties.has(key)) {
                    // Keep active, remove from set of to-be-deleted
                    activeSpecialties.delete(key);
                } else {
                    // Check if there's a soft-deleted entry for this name
                    const deletedRes = await client.query(
                        `SELECT specialty_id FROM organization_specialties 
                         WHERE org_id = $1 AND LOWER(name) = $2 AND is_deleted = TRUE`,
                        [orgId, key]
                    );

                    if (deletedRes.rowCount > 0) {
                        // Restore soft deleted entry
                        await client.query(
                            `UPDATE organization_specialties SET is_deleted = FALSE WHERE specialty_id = $1`,
                            [deletedRes.rows[0].specialty_id]
                        );
                    } else {
                        // Insert new specialty
                        await client.query(
                            `INSERT INTO organization_specialties (org_id, name) VALUES ($1, $2)`,
                            [orgId, cleanName]
                        );
                    }
                }
            }

            // Inactive (soft delete) remaining ones
            if (activeSpecialties.size > 0) {
                await client.query(
                    `UPDATE organization_specialties SET is_deleted = TRUE WHERE specialty_id = ANY($1::uuid[])`,
                    [Array.from(activeSpecialties.values())]
                );
            }
        }

        // Audit log
        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
             VALUES ('ORGANIZATION', $1, $2, 'UPDATE_ABOUT', $3)`,
            [orgId, userId, JSON.stringify({
                updatedSections: Object.keys(req.body),
                officesCount: offices?.length,
                linksCount: links?.length,
                specialtiesCount: specialties?.length,
            })]
        );

        await client.query('COMMIT');

        // Return the authoritative saved state so the client can update its
        // cache directly from this response instead of racing a refetch.
        const [aboutRes, officesRes, linksRes, specialtiesRes] = await Promise.all([
            pool.query(`SELECT description, slogan FROM organizations WHERE org_id = $1`, [orgId]),
            pool.query(
                `SELECT office_id, city, country, address, is_headquarters
                 FROM organization_offices WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY is_headquarters DESC, city ASC`,
                [orgId]
            ),
            pool.query(
                `SELECT link_id, platform, url, display_label
                 FROM organization_links WHERE org_id = $1 AND is_deleted = FALSE
                 ORDER BY platform ASC`,
                [orgId]
            ),
            pool.query(
                `SELECT specialty_id, name FROM organization_specialties
                 WHERE org_id = $1 AND is_deleted = FALSE ORDER BY name ASC`,
                [orgId]
            ),
        ]);

        return res.json({
            message: 'About updated successfully',
            about: aboutRes.rows[0],
            offices: officesRes.rows,
            links: linksRes.rows,
            specialties: specialtiesRes.rows,
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('updateOrgAbout error:', err);
        if (err.statusCode === 403) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// API 10 — PUT /organizations/:orgId/verification  (Update Step 3 — verification details)
// ---------------------------------------------------------------------------

exports.updateOrgVerification = async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const { country_of_operation } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Resolve org
        const orgCheck = await client.query(
            `SELECT created_by, onboarding_completed FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
            [orgId]
        );

        if (orgCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Organization not found' });
        }

        const org = orgCheck.rows[0];

        // Permission check: creator checks for onboarding, MANAGE_VERIFICATION for completed ones
        if (org.onboarding_completed === false) {
            if (org.created_by !== userId) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: 'Forbidden: You are not the creator of this onboarding draft' });
            }
        } else {
            const canVerify = await checkOrgPermission(client, orgId, userId, 'MANAGE_VERIFICATION');
            if (!canVerify) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: 'Forbidden: You do not have permission to manage verification details' });
            }
        }

        // Update country (country_of_operation) and set verification status
        if (country_of_operation) {
            await client.query(
                `UPDATE organizations 
                 SET country = $1, 
                     verification_status = 'DOCUMENT_PENDING',
                     updated_at = NOW() 
                 WHERE org_id = $2`,
                [country_of_operation.trim(), orgId]
            );
        }

        // Save verification documents
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const docUrl = file.path.replace(/\\/g, "/");
                const docName = file.originalname || 'document';
                const docType = file.mimetype || 'application/pdf';

                await client.query(
                    `INSERT INTO organization_documents (org_id, document_url, document_name, document_type)
                     VALUES ($1, $2, $3, $4)`,
                    [orgId, docUrl, docName, docType]
                );
            }
        }

        // Audit log
        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
             VALUES ('ORGANIZATION', $1, $2, 'DOCUMENTS_SUBMITTED', $3)`,
            [orgId, userId, JSON.stringify({ count: req.files ? req.files.length : 0, country: country_of_operation })]
        );

        await client.query('COMMIT');
        return res.json({
            success: true,
            message: 'Verification details submitted successfully',
            verification_status: 'DOCUMENT_PENDING'
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('updateOrgVerification error:', err);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

async function calculateEmployeeGrowth(client, orgId) {
    const query = `
        WITH months AS (
            SELECT m::int AS month_num 
            FROM generate_series(1, EXTRACT(MONTH FROM CURRENT_DATE)::int) m
        ),
        start_count AS (
            SELECT COUNT(DISTINCT profile_id) AS base_count
            FROM experiences
            WHERE org_id = $1::uuid
              AND start_date < DATE_TRUNC('year', CURRENT_DATE)
              AND (end_date IS NULL OR end_date >= DATE_TRUNC('year', CURRENT_DATE))
        ),
        joins AS (
            SELECT 
                EXTRACT(MONTH FROM start_date)::int AS month_num,
                COUNT(DISTINCT profile_id)::int AS join_count
            FROM experiences
            WHERE org_id = $1::uuid
              AND start_date >= DATE_TRUNC('year', CURRENT_DATE)
              AND start_date <= CURRENT_DATE
            GROUP BY month_num
        ),
        departures AS (
            SELECT 
                EXTRACT(MONTH FROM end_date)::int AS month_num,
                COUNT(DISTINCT profile_id)::int AS departure_count
            FROM experiences
            WHERE org_id = $1::uuid
              AND end_date >= DATE_TRUNC('year', CURRENT_DATE)
              AND end_date <= CURRENT_DATE
            GROUP BY month_num
        )
        SELECT 
            (SELECT base_count FROM start_count) AS base_count,
            json_agg(
                json_build_object(
                    'month_num', m.month_num,
                    'join_count', COALESCE(j.join_count, 0),
                    'departure_count', COALESCE(d.departure_count, 0)
                ) ORDER BY m.month_num
            ) AS monthly_stats
        FROM months m
        LEFT JOIN joins j ON m.month_num = j.month_num
        LEFT JOIN departures d ON m.month_num = d.month_num;
    `;
    const res = await client.query(query, [orgId]);
    if (res.rowCount === 0) {
        return {
            percentage: "0.0%",
            growth_value: 0,
            base_count: 0,
            current_headcount: 0,
            total_joins: 0,
            max_y: 5,
            y_ticks: [5, 0],
            start_month: "January",
            current_month: "January",
            trend: []
        };
    }

    const baseCount = parseInt(res.rows[0].base_count || 0);
    const monthlyStats = res.rows[0].monthly_stats || [];

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fullMonthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    let currentHeadcount = baseCount;
    let maxHeadcount = baseCount;
    let totalJoins = 0;

    const trend = monthlyStats.map(item => {
        const joins = parseInt(item.join_count || 0);
        const departures = parseInt(item.departure_count || 0);
        totalJoins += joins;
        currentHeadcount = Math.max(0, currentHeadcount + joins - departures);
        if (currentHeadcount > maxHeadcount) maxHeadcount = currentHeadcount;

        return {
            month_num: item.month_num,
            month: monthNames[item.month_num - 1],
            full_month: fullMonthNames[item.month_num - 1],
            joins,
            departures,
            headcount: currentHeadcount
        };
    });

    const maxY = Math.max(5, Math.ceil(maxHeadcount / 5) * 5);
    const yTicks = [];
    for (let i = maxY; i >= 0; i -= 5) {
        yTicks.push(i);
    }

    let percentageStr = "0.0%";
    let growthValue = 0;
    if (baseCount > 0) {
        growthValue = Math.round(((currentHeadcount - baseCount) / baseCount) * 100 * 10) / 10;
        percentageStr = (growthValue >= 0 ? "+" : "") + growthValue + "%";
    } else if (currentHeadcount > 0) {
        growthValue = 100.0;
        percentageStr = "+100.0%";
    }

    return {
        percentage: percentageStr,
        growth_value: growthValue,
        base_count: baseCount,
        current_headcount: currentHeadcount,
        total_joins: totalJoins,
        max_y: maxY,
        y_ticks: yTicks,
        start_month: trend.length > 0 ? trend[0].full_month : "January",
        current_month: trend.length > 0 ? trend[trend.length - 1].full_month : "July",
        trend
    };
}



