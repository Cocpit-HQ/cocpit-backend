const featureFlagsService = require("../config/featureFlags.service");
const pool = require("../../core/db/pool");
const { hydrateShareCounts } = require("../../utils/shareHydration");
const AppError = require("../../core/errors/AppError");
const current_user = require("../profile/profile.controller");
const profileRepo = require("../profile/profile.repository");
const dashboardService = require("../dashboard/dashboard.service");
const profileCalc = require("../profile/profile.calculator");
const crypto = require("crypto");
const redisClient = require("../../core/db/redis");
const socketService = require("../../core/infrastructure/socket.service");
const { sendAccountDeletionEmail } = require("../../core/services/email.service");
const { verifyGoogleToken } = require("../auth/googleAuth.service");
const { comparePassword } = require("../../core/utils/password");
const { checkBlockStatus, checkActorBlockStatus } = require("../../core/utils/blockCheck");
const { logAudit } = require("../../core/infrastructure/audit.service");

/**
 * GET /api/users/search
 * Purpose: Real-time user discovery and mention autocomplete
 */
exports.searchUsers = async (req, res) => {
  const flags = featureFlagsService.getFlags();
  if (flags["enableGlobalSearch"] === false) {
    return res.status(403).json({ message: "Search is currently disabled." });
  }

  const { q, accountType, excludeJobId } = req.query;
  const currentUserId = req.user.sub;

  if (!q || typeof q !== "string" || q.trim().length === 0) {
    return res.status(400).json({ message: "Search query 'q' is required" });
  }

  const searchTerm = q.trim().replace(/^['"]|['"]$/g, '');

  try {
    const isOrgActor = req.actor?.type === "ORGANIZATION";
    const blockerId = isOrgActor ? (req.actor.orgId || currentUserId) : currentUserId;

    const queryParams = [blockerId]; // $1 = blocker identity (user or org)
    const likeTerm = `%${searchTerm}%`;
    queryParams.push(likeTerm); // $2

    let userAccountFilter = "";
    if (accountType) {
      queryParams.push(accountType); // $3 or so
      userAccountFilter = `AND p.account_type = $${queryParams.length}`;
    }

    let excludeJobFilter = "";
    if (excludeJobId) {
      queryParams.push(excludeJobId);
      excludeJobFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM job_offers jo 
          WHERE jo.job_id = $${queryParams.length} AND jo.user_id = u.user_id
          AND jo.status IN ('pending', 'accepted', 'declined')
        )
      `;
    }

    let blockFilter;
    if (isOrgActor && req.actor?.orgId) {
      blockFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM blocks b 
          WHERE b.is_org_block = true 
            AND b.blocker_id = $1
            AND b.blocked_id = u.user_id
        )
      `;
    } else {
      blockFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM blocks b 
          WHERE b.is_org_block = false
            AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
              OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
        )
      `;
    }

    let tagPrivacyFilter = "";
    let orgTagPrivacyFilter = "";
    if (req.query.forTagging === "true") {
      tagPrivacyFilter = `
        AND u.tag_permission != 'noone'
        AND u.tag_permission != 'no_one'
        AND (
          u.tag_permission = 'everyone'
          OR u.tag_permission IS NULL
          OR (
            u.tag_permission IN ('connections', 'connections_only')
            AND EXISTS (
              SELECT 1 FROM connections c 
              WHERE (c.user_id = $1 AND c.connected_user_id = u.user_id) 
                 OR (c.user_id = u.user_id AND c.connected_user_id = $1)
            )
          )
          OR (
            u.tag_permission IN ('followers', 'followers_only')
            AND EXISTS (
              SELECT 1 FROM followers f 
              WHERE f.follower_id = $1 AND f.following_id = u.user_id
            )
          )
        )
      `;

      const orgFollowCheck = isOrgActor
        ? `EXISTS (SELECT 1 FROM organization_org_follows WHERE follower_org_id = $1 AND following_org_id = c.org_id)`
        : `EXISTS (SELECT 1 FROM organization_followers WHERE user_id = $1 AND org_id = c.org_id)`;

      orgTagPrivacyFilter = `
        AND COALESCE(ops.tag_permission, 'everyone') != 'noone'
        AND COALESCE(ops.tag_permission, 'everyone') != 'no_one'
        AND (
          ops.tag_permission = 'everyone'
          OR ops.tag_permission IS NULL
          OR (
            ops.tag_permission = 'followers_only'
            AND ${orgFollowCheck}
          )
        )
      `;
    }



    // Starts-with param for sorting
    queryParams.push(`${searchTerm}%`);
    const startsWithIdx = queryParams.length;

    const orgBlockFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.blocker_id = $1 AND b.blocked_id = c.org_id)
           OR (b.blocker_id = c.org_id AND b.blocked_id = $1)
      )
    `;

    const queryText = `
      SELECT * FROM (
        (
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
            COALESCE(u.tag_permission, 'everyone')::text AS tag_permission
          FROM active_users u
          LEFT JOIN profiles p ON u.user_id = p.user_id
          WHERE u.is_deactivated = FALSE
            AND (u.full_name ILIKE $2 OR u.account_name ILIKE $2)
            AND u.full_name IS NOT NULL AND TRIM(u.full_name) <> ''
            AND u.account_name IS NOT NULL AND TRIM(u.account_name) <> ''
          ${userAccountFilter}
          ${excludeJobFilter}
          ${blockFilter}
          ${tagPrivacyFilter}
        )
        UNION ALL
        (
          SELECT
            c.org_id AS id,
            c.name AS full_name,
            c.slug AS account_name,
            c.headline AS headline,
            c.logo_url AS avatar_url,
            c.entity_type AS account_type,
            'COMPANY'::text as type,
            c.slug as slug,
            c.industry as industry,
            COALESCE(ops.tag_permission, 'everyone')::text AS tag_permission
          FROM organizations c
          LEFT JOIN organization_privacy_settings ops ON c.org_id = ops.org_id
          WHERE c.is_deleted = FALSE AND c.is_deactivated = FALSE
          AND (c.name ILIKE $2 OR c.slug ILIKE $2)
          ${orgBlockFilter}
          ${orgTagPrivacyFilter}
        )
      ) AS combined_results
      ORDER BY 
        CASE WHEN full_name ILIKE $${startsWithIdx} THEN 0 ELSE 1 END,
        full_name ASC
      LIMIT 50
    `;

    const result = await pool.query(queryText, queryParams);

    // Track search appearances
    if (result.rows.length > 0) {
      result.rows.forEach(profile => {
        // Map COMPANY to organization for schema compatibility
        const profileType = profile.type === 'COMPANY' ? 'organization' : 'user';
        dashboardService.addSearchAppearance(blockerId, profile.id, profileType)
          .catch(err => console.error("Error recording search appearance:", err));
      });
    }

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Search users error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/users/:id
 * Purpose: Public profile viewing
 */
exports.getUserProfile = async (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.sub;

  if (id === currentUserId) {
    return current_user.getMyProfile(req, res);
  }


  // Basic validation for UUID
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  let targetUserId = id;

  // Import block check util if not already imported (it's not)


  // ... existing code ...

  if (!uuidRegex.test(id)) {
    // If not a UUID, try to resolve as account_name (case-insensitive)
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM active_users WHERE LOWER(account_name) = LOWER($1) AND is_deactivated = FALSE",
        [id]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  // --- Block Check Implementation ---
  if (targetUserId !== currentUserId) {
    const activeActorId = req.actor?.type === "ORGANIZATION" && req.actor?.orgId
      ? req.actor.orgId
      : req.user?.sub;

    // 1. Check if TARGET blocked the VIEWER (Blocked side - viewer strictly receives 404)
    const blockedByTargetRes = await pool.query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [targetUserId, activeActorId]
    );
    if (blockedByTargetRes.rowCount > 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Check if VIEWER blocked the TARGET (Blocker side - viewer sees minimal blocked view)
    const blockedByViewerRes = await pool.query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [activeActorId, targetUserId]
    );
    if (blockedByViewerRes.rowCount > 0) {
      const userRes = await pool.query(
        `SELECT
           u.user_id AS id,
           u.account_name,
           u.full_name AS name,
           u.headline,
           u.about_text AS about,
           u.location,
           u.avatar_url AS avatar,
           u.cover_image_url AS cover_image
         FROM active_users u
         WHERE u.user_id = $1 AND u.is_deactivated = FALSE`,
        [targetUserId]
      );
      if (userRes.rowCount === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      const user = userRes.rows[0];
      return res.status(200).json({
        user: {
          ...user,
          followers_count: 0,
          following_count: 0,
          connections_count: 0,
          is_blocked_by_me: true,
          is_following: false,
          is_followed_by: false,
          connection_request_status: null,
          connection_request_id: null,
          connection_request_sender: null,
          open_to: null,
          availability: null,
          work_preference: null,
          working_industry: null,
          organization_roles: [],
          company_roles: [],
        },
        experiences: [],
        educations: [],
        projects: [],
        skills: [],
        posts: [],
        resume: null,
      });
    }
  }
  // ----------------------------------


  try {
    // --- Centralized View Counting Logic (Redis + Atomic DB) ---
    const actorContext = req.actor || null;
    if (targetUserId !== currentUserId) {

      const viewerCompanyOrgId = actorContext && actorContext.type === "ORGANIZATION" ? actorContext.orgId : null;
      const sourcePostId = req.query.source_post_id || req.query.sourcePostId || null;
      const source = req.query.source || (sourcePostId ? 'post' : null);

      // Fire and forget view recording to keep profile load fast
      dashboardService.addProfileView(currentUserId, targetUserId, 'user', { source, sourcePostId, viewerCompanyOrgId, actor: actorContext })
        .catch(err => console.error("Error recording user profile view:", err));
    }
    // -----------------------------------------------------------

    // 1. Fetch User & Profile Data
    const userQuery = `
      SELECT
        u.user_id AS id,
        p.profile_id,
        u.account_name,
        u.full_name AS name,
        u.headline,
        u.avatar_url AS avatar,
        u.cover_image_url AS cover_image,
        u.location,
        u.about_text AS about,
        u.website,
        u.email,
        u.recovery_email,
        u.mobile_number,
        u.profile_show_email,
        u.profile_show_phone,
        u.created_at,
        u.is_identity_verified,
        p.account_type,
        p.open_to,
        p.availability,
        p.work_preference,
        p.working_industry AS industry
       
      FROM active_users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id = $1 AND u.is_deactivated = FALSE
    `;
    const userResult = await pool.query(userQuery, [targetUserId]);

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userResult.rows[0];
    const profileId = user.profile_id;
    delete user.profile_id; // Remove from response payload

    // Log audit when viewing another user's profile under Organization actor context
    if (targetUserId !== currentUserId && actorContext && actorContext.type === "ORGANIZATION" && actorContext.orgId) {

      const handleOrId = user.account_name || targetUserId;
      logAudit(pool, {
        entityId: actorContext.orgId,
        actorId: currentUserId,
        actorRole: actorContext.roleName || null,
        action: 'VIEW_USER_PROFILE',
        metadata: {
          targetId: targetUserId,
          targetName: user.name,
          targetHandle: user.account_name,
          targetType: 'user',
          linkUrl: `/u/${handleOrId}`,
          highlightedText: 'profile'
        }
      }).catch(err => console.error("Error logging user profile view audit:", err));
    }

    // 2. Fetch Experiences, Educations, Projects & Resume using profileRepo
    const [experiences, educations, projects, resumeRow] = await Promise.all([
      profileId ? profileRepo.getExperiences(profileId) : [],
      profileId ? profileRepo.getEducations(profileId) : [],
      profileId ? profileRepo.getProjects(profileId) : [],
      profileRepo.getLatestResume(targetUserId)
    ]);

    const resume = resumeRow ? { originalName: resumeRow.file_name, url: resumeRow.file_url } : null;

    // 4. Fetch Skills
    const skillsQuery = `
      SELECT s.skill_id, s.name
      FROM user_skills us
      JOIN skills s ON us.skill_id = s.skill_id
      WHERE us.profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
    `;
    const skillsResult = await pool.query(skillsQuery, [targetUserId]);

    // 5. Check social relationship (following, followed_by, connection status)
    let isFollowing = false;
    let isFollowedBy = false;
    let connectionRequestStatus = null;
    let connectionRequestId = null;
    let connectionRequestSender = null;

    if (currentUserId && (currentUserId !== targetUserId || (req.headers['x-actor-type'] || '').toUpperCase().trim() === 'ORGANIZATION')) {
      // Detect if the request is made under an Organization actor context
      const actorType = (req.headers['x-actor-type'] || '').toUpperCase().trim();
      const actorOrgId = req.headers['x-actor-id'] || null;
      const isOrgActor = actorType === 'ORGANIZATION' && !!actorOrgId;

      if (isOrgActor) {
        // Check if the organization follows this user
        const followCheck = await pool.query(
          "SELECT 1 FROM organization_user_follows WHERE org_id = $1 AND user_id = $2",
          [actorOrgId, targetUserId]
        );
        isFollowing = followCheck.rowCount > 0;
      } else {
        // Check Following (Me -> Them) for personal user context
        const followCheck = await pool.query(
          "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
          [currentUserId, targetUserId]
        );
        isFollowing = followCheck.rowCount > 0;
      }

      // Check Followed By (Them -> Me)
      const followedByCheck = await pool.query(
        "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
        [targetUserId, currentUserId]
      );
      isFollowedBy = followedByCheck.rowCount > 0;

      // Check True Connection
      const connectionCheck = await pool.query(
        "SELECT 1 FROM connections WHERE user_id = $1 AND connected_user_id = $2",
        [currentUserId, targetUserId]
      );
      const isConnected = connectionCheck.rowCount > 0;

      if (isConnected) {
        // `connections` is a personal, user-to-user relationship — it says nothing
        // about whether the acting ORGANIZATION follows this person, so don't let
        // it stomp the org-aware isFollowing computed above when acting as a company.
        if (!isOrgActor) {
          isFollowing = true;
        }
        isFollowedBy = true;
        connectionRequestStatus = 'connected';
      }

      // Only check requests if NOT already connected
      if (!isConnected) {
        const requestCheck = await pool.query(
          `SELECT request_id, sender_id, status 
           FROM connection_requests 
           WHERE ((sender_id = $1 AND receiver_id = $2) 
              OR (sender_id = $2 AND receiver_id = $1))
             AND status != 'connected'`,
          [currentUserId, targetUserId]
        );

        if (requestCheck.rowCount > 0) {
          const reqRow = requestCheck.rows[0];
          connectionRequestStatus = reqRow.status;
          connectionRequestId = reqRow.request_id;
          connectionRequestSender = reqRow.sender_id === currentUserId ? 'me' : 'them';
        }
      }
    }

    // Privacy gating for email, recovery email, and phone number
    const isOwner = currentUserId === targetUserId;
    user.email = (isOwner || user.profile_show_email) ? (user.email || null) : null;
    user.mobile_number = (isOwner || user.profile_show_phone) ? (user.mobile_number || null) : null;
    if (isOwner) {
      user.recovery_email = user.recovery_email || null;
    } else {
      delete user.recovery_email;
    }
    delete user.profile_show_email;
    delete user.profile_show_phone;

    // Enrich user object with social fields
    user.is_following = isFollowing;
    user.is_followed_by = isFollowedBy;
    user.connection_request_status = connectionRequestStatus;
    user.connection_request_id = connectionRequestId;
    user.connection_request_sender = connectionRequestSender;

    // 6. Fetch follower/following/connection counts
    const countsResult = await pool.query(
      `SELECT 
        (
            SELECT COUNT(*) 
            FROM followers f
            JOIN active_users u ON f.follower_id = u.user_id
            WHERE f.following_id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                  WHERE b.is_org_block = false
                    AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
                      OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
              )
        ) + (
            SELECT COUNT(*) 
            FROM organization_user_follows ouf
            JOIN organizations o ON ouf.org_id = o.org_id
            WHERE ouf.user_id = $1 AND o.is_deleted = FALSE
        ) as followers_count,
        (
            SELECT COUNT(*) 
            FROM followers f
            JOIN active_users u ON f.following_id = u.user_id
            WHERE f.follower_id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                  WHERE b.is_org_block = false
                    AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
                      OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
              )
        ) + (
            SELECT COUNT(*) 
            FROM organization_followers cf 
            JOIN organizations c ON cf.org_id = c.org_id 
            WHERE cf.user_id = $1 AND c.is_deleted = FALSE
        ) as following_count,
        (
            SELECT COUNT(*) 
            FROM connections c
            JOIN active_users u ON c.connected_user_id = u.user_id
            WHERE c.user_id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM blocks b 
                  WHERE b.is_org_block = false
                    AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
                      OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
              )
        ) + (
            SELECT COUNT(*) 
            FROM organization_connections cc 
            JOIN organizations c ON cc.org_id = c.org_id 
            WHERE cc.user_id = $1 AND c.is_deleted = FALSE
        ) as connections_count
      `,
      [targetUserId]
    );
    const counts = countsResult.rows[0];
    user.followers_count = parseInt(counts.followers_count);
    user.following_count = parseInt(counts.following_count);
    user.connections_count = parseInt(counts.connections_count);

    // 7. Fetch Company Roles (Public View - Only Visible Roles)
    const companyRoles = await pool.query(
      `
      SELECT 
        c.org_id, 
        c.org_id as company_id,
        c.name, 
        c.slug, 
        c.logo_url, 
        COALESCE(cr.name, cm.role) as role,
        cm.is_primary_display,
        cm.is_role_visible
      FROM organization_members cm
      JOIN organizations c ON cm.org_id = c.org_id
      LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
      WHERE cm.user_id = $1 
      AND cm.is_role_visible = TRUE
      AND c.is_deleted = FALSE AND c.is_deactivated = FALSE
      ORDER BY cm.is_primary_display DESC, COALESCE(cr.priority, 0) DESC, c.name ASC
      `,
      [targetUserId]
    );

    // Calculate profile score
    const userProfileForScore = {
      full_name: user.name,
      headline: user.headline,
      location: user.location,
      account_type: user.account_type,
      about_text: user.about,
      open_to: user.open_to,
      availability: user.availability,
      work_preference: user.work_preference,
      avatar_url: user.avatar,
      cover_image_url: user.cover_image
    };

    // Commented out broken experience flattening logic by previous developer
    // const flatExperiencesForScore = (experiences || []).flatMap(group => 
    //   Array.isArray(group.experiences) ? group.experiences.map(exp => ({
    //     company_name: exp.company_name || group.company_name,
    //     title: exp.title,
    //     start_date: exp.start_date,
    //     description: exp.description
    //   })) : []
    // );

    const profileScore = profileCalc.calculateFullProfileScore(
      userProfileForScore, 
      skillsResult.rows, 
      experiences, 
      projects, 
      educations
    );

    // Assemble response
    const responseData = {
      user: user,
      experiences: experiences,
      educations: educations,
      projects: projects,
      skills: skillsResult.rows,
      organization_roles: companyRoles.rows,
      resume: resume,
      profile_score: profileScore,
    };

    console.log("SENDING USER PROFILE RESPONSE FOR", targetUserId, "PROJECTS COUNT:", projects ? projects.length : 0);
    return res.status(200).json(responseData);
  } catch (err) {
    console.error("Get user profile error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPublicProfilePosts = async (req, res) => {
  const { id: userId } = req.params;
  const {
    category,
    filter: queryFilter,
    cursorCreatedAt,
    cursorPostId,
    limit = 10,
    preview,
  } = req.query;

  // Preview mode (profile page's post preview strip): returns posts in priority
  // order (media posts first, then plain text, then reposts/polls), with recency
  // ordering preserved within each tier.
  const isPreview = preview === 'true' || preview === true;

  // ✅ Validate UUID
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  let targetUserId = userId;

  if (!uuidRegex.test(userId)) {
    // If not a UUID, try to resolve as account_name (case-insensitive)
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM active_users WHERE LOWER(account_name) = LOWER($1) AND is_deactivated = FALSE",
        [userId]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error in posts:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  // --- Block Check Implementation ---
  const currentUserId = req.user ? req.user.sub : null;
  if (currentUserId && targetUserId !== currentUserId) {

    const isBlocked = await checkActorBlockStatus(req, targetUserId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }
  // ----------------------------------


  try {
    const params = [targetUserId];
    let idx = 2;
    let whereClause = "";

    // Support both ?filter=... and legacy ?category=... (if category matches a filter name)
    const filterTabs = ['Repost', 'Articles', 'Article', 'Video', 'Videos', 'Poll', 'Polls', 'Post', 'Comments'];
    let filter = queryFilter;
    let effectiveCategory = category;

    if (!filter && category && filterTabs.includes(category)) {
      filter = category;
      effectiveCategory = 'All';
    }

    if (effectiveCategory === 'Comments' || filter === 'Comments') {
      whereClause = `WHERE EXISTS (SELECT 1 FROM active_post_comments pc_filter WHERE pc_filter.post_id = p.post_id AND pc_filter.author_id = $1) AND p.visibility = 'public' AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL) `;
    } else {
      whereClause = `WHERE p.author_id = $1 AND p.author_org_id IS NULL AND p.visibility = 'public' AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL) `;
    }

    // ✅ Category filter (skip "All")
    if (effectiveCategory && effectiveCategory !== "All") {
      whereClause += ` AND pc.name = $${idx}`;
      params.push(effectiveCategory);
      idx++;
    }

    // ✅ Filter key handling (Post, Repost, Articles, Video, Poll, Private post)
    if (filter) {
      if (filter === 'Post') {
        whereClause += ` AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
      } else if (filter === 'Repost') {
        whereClause += ` AND (p.shared_post_id IS NOT NULL OR p.shared_job_id IS NOT NULL) `;
      } else if (filter === 'Private post') {
        if (targetUserId !== currentUserId) {
          return res.json({ posts: [], nextCursor: null });
        }
        whereClause = `WHERE p.author_id = $1 AND p.author_org_id IS NULL AND p.visibility = 'private' AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL) `;
      } else if (filter === 'Articles' || filter === 'Article') {
        whereClause += ` AND (p.post_type = 'article' OR pc.name = 'Article' OR p.is_community_article = TRUE) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
      } else if (filter === 'Video' || filter === 'Videos') {
        whereClause += ` AND (p.post_type = 'video' OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'video')) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
      } else if (filter === 'Poll' || filter === 'Polls') {
        whereClause += ` AND (p.post_type = 'poll' OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
      }
    }

    whereClause += `
      AND (
          p.shared_post_id IS NULL 
          OR (
              (sp.author_org_id IS NOT NULL OR (sp_u.is_deactivated = FALSE AND (sp_u.is_deleted IS NULL OR sp_u.is_deleted = FALSE)))
              AND (sp.author_org_id IS NULL OR (sp_comp.is_deleted = FALSE AND sp_comp.is_deactivated = FALSE))
          )
      )
    `;


    // ✅ Cursor-based pagination (stable ordering)
    if (cursorCreatedAt && cursorPostId) {
      whereClause += `
        AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})
      `;
      params.push(cursorCreatedAt, cursorPostId);
      idx += 2;
    }

    // ✅ LIMIT (provide a buffer for preview mode so frontend can filter hidden posts)
    params.push(isPreview ? Math.max(Number(limit) || 10, 10) : limit);

    // ✅ Strict Block Logic for Shared Posts (dependant on userParamIdx which is derived from params.length + 1)
    // We can't interpolate userParamIdx here because it's calculated afterwards.
    // BUT, we know userParamIdx will be the LAST parameter pushed (req.user.sub).
    // So usually it is params.length + 1 (after limit).
    // Let's use a placeholder or interpolation.
    // Actually, userParamIdx is calculated at line 313.
    // Accessing it inside whereClause string is fine because whereClause is interpolated into query string at line 435.
    // So we just need to ensure we use the variable `${userParamIdx}` in the string literal, but `userParamIdx` isn't defined yet!
    // Ah, wait. `whereClause` is a string accumulating parts.
    // If I add it *before* `userParamIdx` is defined, I can't use `userParamIdx`.
    // OPTION: Add it to the query string *literally* at line 436, using `${userParamIdx}` which IS defined there.

    // Changing approach: I will modify the query string directly at line 437.


    const userParamIdx = params.length + 1; // Index for current user (will be pushed later)

    const query = `
      SELECT
        p.post_id,
        p.content,
        p.title,
        p.post_type,
        p.created_at,
        p.visibility,
        p.location,
        (
            SELECT COALESCE(json_agg(json_build_object(
                'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
                'full_name', COALESCE(u_mention.full_name, o_mention.name),
                'account_name', COALESCE(u_mention.account_name, o_mention.slug)
            )), '[]'::json)
            FROM (
                SELECT DISTINCT (regexp_matches(COALESCE(p.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
            ) mentions
            LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
            LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id AND o_mention.is_deleted = FALSE
            WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
        ) AS mentioned_users,

        u.user_id AS author_id,
        u.full_name AS author_name,
        u.avatar_url AS author_avatar,
        u.account_name AS author_slug,
        u.headline AS author_headline,

        pc.name AS category_name,

        COALESCE(
          (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height)) 
           FROM post_media pm WHERE pm.post_id = p.post_id),
          '[]'::json
        ) AS media,

        (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
        (SELECT COUNT(*) FROM posts sp_share WHERE sp_share.shared_post_id = p.post_id AND sp_share.is_active = TRUE AND (sp_share.is_removed IS FALSE OR sp_share.is_removed IS NULL))::int AS "rePostCount",
        (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = p.post_id::text)::int AS "sharePostCount",
        (
            SELECT COALESCE(comp_like.slug, u_like.account_name)
            FROM active_post_likes pl_sample
            LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
            LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
            WHERE pl_sample.post_id = p.post_id
            AND pl_sample.user_id IS DISTINCT FROM $${userParamIdx}
            ORDER BY pl_sample.created_at DESC
            LIMIT 1
        ) AS sample_liker_username,
        (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

        EXISTS(SELECT 1 FROM active_post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $${userParamIdx}) AS is_liked,
        EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL) AS is_saved,
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        ) AS is_reposted,
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
        ) AS is_reposted_with_thoughts,
        (
            SELECT sp_rep.post_id FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
            LIMIT 1
        ) AS repost_id,
        (
            SELECT COALESCE(
                json_agg(json_build_object(
                    'username', COALESCE(comp_like.slug, u_like.account_name),
                    'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                )),
                '[]'::json
            )
            FROM (
                SELECT pl_sample.user_id, pl_sample.org_id
                FROM active_post_likes pl_sample
                WHERE pl_sample.post_id = p.post_id
                  AND pl_sample.user_id IS NOT NULL
                  AND pl_sample.user_id != $${userParamIdx}::uuid
                ORDER BY pl_sample.created_at DESC
                LIMIT 3
            ) sub
            LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
            LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
        ) AS liked_users,

        (
          SELECT json_build_object(
            'poll_id', pp.poll_id,
            'duration', COALESCE(pp.duration, '1 day'),
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
            'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx} LIMIT 1),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
            'options', COALESCE(
              (SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id))) FROM poll_options po WHERE po.poll_id = pp.poll_id),
              '[]'::json
            )
          )
          FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1
        ) AS poll,

        --Shared Post Data
        CASE 
          WHEN p.shared_job_id IS NOT NULL THEN
            json_build_object(
                 'is_accessible', true,
                 'job_id', sj.job_id,
                 'title', sj.title,
                 'company_name', sj.company_name,
                 'location', sj.location,
                 'job_type', sj.job_type,
                 'work_mode', sj.work_mode,
                 'salary_min', sj.salary_min,
                 'salary_max', sj.salary_max,
                 'company_logo', sj_comp.logo_url,
                 'created_at', sj.created_at,
                 'is_active', sj.is_active,
                 'company_slug', sj_comp.slug,
                 'shared_entity_type', 'job'
            )
          WHEN p.shared_post_id IS NULL THEN NULL
          WHEN sp.post_id IS NULL THEN 
            json_build_object('is_accessible', false, 'reason', 'deleted')
          WHEN (
            --1. Private: Author only
            (sp.visibility = 'private' AND sp.author_id = $${userParamIdx})
            OR
            --2. Public + Personal: Connections only
            (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
              sp.author_id = $${userParamIdx}
              OR EXISTS(
                  SELECT 1 FROM followers f1 
                  JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                  WHERE f1.follower_id = $${userParamIdx} AND f1.following_id = sp.author_id
              )
            ))
            OR
            --3. Public + Other: Everyone
            (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
          ) THEN
            json_build_object(
              'is_accessible', true,
              'post_id', sp.post_id,
              'content', sp.content,
              'location', sp.location,
              'created_at', sp.created_at,
              'author', json_build_object(
                'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                'author_headline', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.headline ELSE sp_u.headline END,
                'is_organization_post', (sp.author_org_id IS NOT NULL)
              ),
              'media', COALESCE((SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height)) FROM post_media pm WHERE pm.post_id = sp.post_id), '[]'::json),
              'like_count', (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = sp.post_id)::int,
              'comment_count', (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = sp.post_id)::int,
              'rePostCount', (SELECT COUNT(*) FROM posts sp_share2 WHERE sp_share2.shared_post_id = sp.post_id AND sp_share2.is_active = TRUE AND (sp_share2.is_removed IS FALSE OR sp_share2.is_removed IS NULL))::int,
              'sharePostCount', (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = sp.post_id::text)::int,
              'is_liked', EXISTS(SELECT 1 FROM active_post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $${userParamIdx}),
              'is_saved', EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = sp.post_id AND sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL),
              'is_reposted', EXISTS(
                  SELECT 1 FROM posts sp_rep
                  WHERE sp_rep.shared_post_id = sp.post_id 
                  AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
                  AND sp_rep.is_active = TRUE
                  AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
              ),
              'is_reposted_with_thoughts', EXISTS(
                  SELECT 1 FROM posts sp_rep
                  WHERE sp_rep.shared_post_id = sp.post_id 
                  AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
                  AND sp_rep.is_active = TRUE
                  AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
              AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
              ),
              'repost_id', (
                  SELECT sp_rep.post_id FROM posts sp_rep
                  WHERE sp_rep.shared_post_id = sp.post_id 
                  AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
                  AND sp_rep.is_active = TRUE
                  AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                  LIMIT 1
              ),
              'liked_users', (
                  SELECT COALESCE(
                      json_agg(json_build_object(
                          'username', COALESCE(comp_like.slug, u_like.account_name),
                          'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                      )),
                      '[]'::json
                  )
                  FROM (
                      SELECT pl_sample.user_id, pl_sample.org_id
                      FROM active_post_likes pl_sample
                      WHERE pl_sample.post_id = sp.post_id
                        AND pl_sample.user_id IS NOT NULL
                        AND pl_sample.user_id != $${userParamIdx}::uuid
                      ORDER BY pl_sample.created_at DESC
                      LIMIT 3
                  ) sub
                  LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
                  LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
              ),
              'poll', (
                SELECT json_build_object(
                  'poll_id', pp.poll_id,
                  'duration', COALESCE(pp.duration, '1 day'),
                  'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                  'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx} LIMIT 1),
                  'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                  'options', COALESCE(
                    (SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id))) FROM poll_options po WHERE po.poll_id = pp.poll_id),
                    '[]'::json
                  )
                )
                FROM post_polls pp WHERE pp.post_id = sp.post_id LIMIT 1
              ),
              'mentioned_users', (
                  SELECT COALESCE(json_agg(json_build_object(
                      'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
                      'full_name', COALESCE(u_mention.full_name, o_mention.name),
                      'account_name', COALESCE(u_mention.account_name, o_mention.slug)
                  )), '[]'::json)
                  FROM (
                      SELECT DISTINCT (regexp_matches(COALESCE(sp.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
                  ) mentions
                  LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
                  LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id AND o_mention.is_deleted = FALSE
                  WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
              )
            )
          --Failure Analysis
          WHEN sp.visibility = 'private' THEN json_build_object(
            'is_accessible', false,
            'reason', 'private',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          WHEN (sp.visibility = 'public' AND sp_cat.name = 'Personal') THEN json_build_object(
            'is_accessible', false,
            'reason', 'personal_connection',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          ELSE
            json_build_object('is_accessible', false, 'reason', 'unknown')
        END AS shared_post

      FROM posts p
      JOIN active_users u ON u.user_id = p.author_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id
      LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
      LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
      LEFT JOIN organizations sp_comp ON sp_comp.org_id = sp.author_org_id
      LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
      LEFT JOIN jobs sj ON p.shared_job_id = sj.job_id
      LEFT JOIN organizations sj_comp ON sj.org_id = sj_comp.org_id

      ${whereClause}

      -- Strict Block Logic: Exclude reposts if original author is blocked
      AND (
          p.shared_post_id IS NULL 
          OR NOT EXISTS (
              SELECT 1 FROM blocks b 
              WHERE (b.is_org_block = false AND sp.author_org_id IS NULL AND ((b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${userParamIdx})))
                 OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${userParamIdx}) OR (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_org_id)))
          )
      )

      -- Hide posts (and reposts of posts) reported by the current user
      AND ($${userParamIdx}::uuid IS NULL OR NOT EXISTS (
          SELECT 1 FROM reports r 
          WHERE r.target_type IN ('POST', 'ARTICLE', 'JOB', 'THOUGHT')
            AND (r.target_id = p.post_id OR r.target_id = p.shared_post_id OR r.target_id = p.shared_job_id)
            AND r.reporter_id = $${userParamIdx}::uuid
      ))

      -- Privacy Escalation: Hide reposts if original post's privacy tightened
      AND (
          p.shared_post_id IS NULL 
          OR sp.post_id IS NULL -- Still show if deleted (but with 'deleted' reason above)
          OR (
              -- Accessible if:
              -- 1. Original is Public + Not personal
              (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
              -- 2. Original is Public + Personal and connected
              OR (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                  sp.author_id = $${userParamIdx}
                  OR EXISTS(
                      SELECT 1 FROM followers f1 
                      JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                      WHERE f1.follower_id = $${userParamIdx} AND f1.following_id = sp.author_id
                  )
              ))
              -- 3. Original is Private and viewer is author
              OR (sp.visibility = 'private' AND sp.author_id = $${userParamIdx})
          )
      )

      ORDER BY
      ${isPreview ? `
        CASE
          -- Tier 1: Original media posts (image/video)
          WHEN p.shared_post_id IS NULL AND p.shared_job_id IS NULL
               AND (
                 p.post_type::text IN ('video', 'image')
                 OR EXISTS (
                   SELECT 1 FROM post_media pm
                   WHERE pm.post_id = p.post_id
                     AND pm.media_type IN ('image', 'video')
                 )
               )
          THEN 1

          -- Tier 2: Original text/article posts (no media, no poll)
          WHEN p.shared_post_id IS NULL AND p.shared_job_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id)
               AND NOT EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)
               AND (p.post_type IS NULL OR p.post_type::text NOT IN ('poll', 'video', 'image'))
          THEN 2

          -- Tier 3: Reposts (shared post or shared job)
          WHEN (p.shared_post_id IS NOT NULL OR p.shared_job_id IS NOT NULL)
          THEN 3

          -- Tier 4: Polls
          WHEN (p.post_type::text = 'poll' OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id))
          THEN 4

          ELSE 5
        END ASC,
      ` : ''}
        p.created_at DESC, p.post_id DESC
      LIMIT $${idx};
    `;

    // Add current user ID to params for is_liked check and user_vote check
    params.push(currentUserId);

    const { rows } = await pool.query(query, params);
    const last = rows[rows.length - 1];

    const hydratedRows = await hydrateShareCounts(rows);

    res.json({
      posts: hydratedRows,
      nextCursor: last
        ? {
          cursorCreatedAt: last.created_at,
          cursorPostId: last.post_id,
        }
        : null,
    });
  } catch (err) {
    console.error("Get public profile posts error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/users/:id/posts/commented
 * Purpose: Public view of posts a user has commented on (only public posts)
 */
exports.getPublicProfileCommentedPosts = async (req, res) => {
  const { id: userId } = req.params;
  const {
    cursorCreatedAt,
    cursorPostId,
    limit = 10,
  } = req.query;

  // Validate / resolve UUID or account_name
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  let targetUserId = userId;

  if (!uuidRegex.test(userId)) {
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM active_users WHERE LOWER(account_name) = LOWER($1) AND is_deactivated = FALSE",
        [userId]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error in commented posts:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  // Block check
  const currentUserId = req.user ? req.user.sub : null;
  if (currentUserId && targetUserId !== currentUserId) {

    const isBlocked = await checkActorBlockStatus(req, targetUserId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }

  try {
    const params = [targetUserId];
    let idx = 2;

    // Only public posts the target user has commented on (excluding their own posts)
    let whereClause = `WHERE EXISTS (
      SELECT 1 FROM active_post_comments pc_filter
      WHERE pc_filter.post_id = p.post_id
        AND pc_filter.author_id = $1
        AND pc_filter.author_org_id IS NULL
    )
    AND p.visibility = 'public'
    AND p.author_id != $1
    AND (
        p.shared_post_id IS NULL 
        OR (
            (sp.author_org_id IS NOT NULL OR (sp_u.is_deactivated = FALSE AND (sp_u.is_deleted IS NULL OR sp_u.is_deleted = FALSE)))
            AND (sp.author_org_id IS NULL OR (sp_comp.is_deleted = FALSE AND sp_comp.is_deactivated = FALSE))
        )
    )`;

    if (cursorCreatedAt && cursorPostId) {
      whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})`;
      params.push(cursorCreatedAt, cursorPostId);
      idx += 2;
    }

    params.push(limit);
    const limitIdx = idx;

    const userParamIdx = params.length + 1;
    params.push(currentUserId || null);

    const query = `
      SELECT
        p.post_id,
        p.content,
        p.created_at,
        p.visibility,
        p.post_type,

        COALESCE(p.author_org_id, u.user_id) AS author_id,
        COALESCE(comp.name, u.full_name) AS author_name,
        COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
        COALESCE(comp.slug, u.account_name) AS author_slug,
        (p.author_org_id IS NOT NULL) AS is_organization_post,
        CASE WHEN p.author_org_id IS NOT NULL THEN comp.headline ELSE u.headline END AS author_headline,

        pc.name AS category_name,
        p.location,

        COALESCE(pm.media, '[]'::json) AS media,
        COALESCE(lc.like_count, 0) AS like_count,

        EXISTS(SELECT 1 FROM active_post_likes pl_me WHERE pl_me.post_id = p.post_id AND pl_me.user_id = $${userParamIdx} AND pl_me.org_id IS NULL) AS is_liked,
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        ) AS is_reposted,
        EXISTS(
                  SELECT 1 FROM posts sp_rep
                  WHERE sp_rep.shared_post_id = sp.post_id 
                  AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
                  AND sp_rep.is_active = TRUE
                  AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
              ),
              'repost_id', (
                  SELECT sp_rep.post_id FROM posts sp_rep
                  WHERE sp_rep.shared_post_id = sp.post_id 
                  AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
                  AND sp_rep.is_active = TRUE
                  AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                  LIMIT 1
              ),
              'liked_users', (
                  SELECT COALESCE(
                      json_agg(json_build_object(
                          'username', COALESCE(comp_like.slug, u_like.account_name),
                          'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                      )),
                      '[]'::json
                  )
                  FROM (
                      SELECT pl_sample.user_id, pl_sample.org_id
                      FROM active_post_likes pl_sample
                      WHERE pl_sample.post_id = sp.post_id
                        AND pl_sample.user_id IS NOT NULL
                        AND pl_sample.user_id != $${userParamIdx}::uuid
                      ORDER BY pl_sample.created_at DESC
                      LIMIT 3
                  ) sub
                  LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
                  LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
              ),
              'poll', (
                SELECT json_build_object(
                  'poll_id', pp.poll_id,
                  'duration', COALESCE(pp.duration, '1 day'),
                  'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                  'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx} LIMIT 1),
                  'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                  'options', COALESCE(
                    (SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id))) FROM poll_options po WHERE po.poll_id = pp.poll_id),
                    '[]'::json
                  )
                )
                FROM post_polls pp WHERE pp.post_id = sp.post_id LIMIT 1
              )
            )
          --Failure Analysis
          WHEN sp.visibility = 'private' THEN json_build_object(
            'is_accessible', false,
            'reason', 'private',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          WHEN (sp.visibility = 'public' AND sp_cat.name = 'Personal') THEN json_build_object(
            'is_accessible', false,
            'reason', 'personal_connection',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          ELSE
            json_build_object('is_accessible', false, 'reason', 'unknown')
        END AS shared_post

      FROM posts p
      JOIN active_users u ON u.user_id = p.author_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id
      LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
      LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
      LEFT JOIN organizations sp_comp ON sp_comp.org_id = sp.author_org_id
      LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id

      ${whereClause}

      ${isPreview
        ? `-- Preview mode: only plain (non-poll, non-repost) posts, UNLESS the
        -- author has none at all, in which case fall back to any type.
        AND (
            NOT EXISTS (
                SELECT 1 FROM posts p_plain
                WHERE p_plain.author_id = $1
                  AND p_plain.author_org_id IS NULL
                  AND p_plain.visibility = 'public'
                  AND p_plain.is_active = TRUE
                  AND (p_plain.is_removed IS FALSE OR p_plain.is_removed IS NULL)
                  AND p_plain.shared_post_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM post_polls pp_plain WHERE pp_plain.post_id = p_plain.post_id)
            )
            OR (
                p.shared_post_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM post_polls pp_cur WHERE pp_cur.post_id = p.post_id)
            )
        )`
        : ''
      }

      -- Strict Block Logic: Exclude reposts if original author is blocked
      AND (
          p.shared_post_id IS NULL 
          OR NOT EXISTS (
              SELECT 1 FROM blocks b 
              WHERE (b.is_org_block = false AND sp.author_org_id IS NULL AND ((b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${userParamIdx})))
                 OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${userParamIdx}) OR (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_org_id)))
          )
      )

      -- Hide posts (and reposts of posts) reported by the current user
      AND ($${userParamIdx}::uuid IS NULL OR NOT EXISTS (
          SELECT 1 FROM reports r 
          WHERE r.target_type IN ('POST', 'ARTICLE', 'JOB', 'THOUGHT')
            AND (r.target_id = p.post_id OR r.target_id = p.shared_post_id OR r.target_id = p.shared_job_id)
            AND r.reporter_id = $${userParamIdx}::uuid
      ))

      -- Privacy Escalation: Hide reposts if original post's privacy tightened
      AND (
          p.shared_post_id IS NULL 
          OR sp.post_id IS NULL -- Still show if deleted (but with 'deleted' reason above)
          OR (
              -- Accessible if:
              -- 1. Original is Public + Not personal
              (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
              -- 2. Original is Public + Personal and connected
              OR (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                  sp.author_id = $${userParamIdx}
                  OR EXISTS(
                      SELECT 1 FROM followers f1 
                      JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                      WHERE f1.follower_id = $${userParamIdx} AND f1.following_id = sp.author_id
                  )
              ))
              -- 3. Original is Private and viewer is author
              OR (sp.visibility = 'private' AND sp.author_id = $${userParamIdx})
          )
      )

      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${idx};
    `;

    // Add current user ID to params for is_liked check and user_vote check
    params.push(req.user.sub);

    const { rows } = await pool.query(query, params);
    const last = rows[rows.length - 1];

    const hydratedRows = await hydrateShareCounts(rows);

    res.json({
      posts: hydratedRows,
      nextCursor: last
        ? {
          cursorCreatedAt: last.created_at,
          cursorPostId: last.post_id,
        }
        : null,
    });
  } catch (err) {
    console.error("Get public profile posts error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/users/:id/posts/commented
 * Purpose: Public view of posts a user has commented on (only public posts)
 */
exports.getPublicProfileCommentedPosts = async (req, res) => {
  const { id: userId } = req.params;
  const {
    cursorCreatedAt,
    cursorPostId,
    limit = 10,
  } = req.query;

  // Validate / resolve UUID or account_name
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  let targetUserId = userId;

  if (!uuidRegex.test(userId)) {
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM active_users WHERE LOWER(account_name) = LOWER($1) AND is_deactivated = FALSE",
        [userId]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error in commented posts:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  // Block check
  const currentUserId = req.user.sub;
  if (targetUserId !== currentUserId) {

    const isBlocked = await checkActorBlockStatus(req, targetUserId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }

  try {
    const params = [targetUserId];
    let idx = 2;

    // Only public posts the target user has commented on (excluding their own posts)
    let whereClause = `WHERE EXISTS (
      SELECT 1 FROM active_post_comments pc_filter
      WHERE pc_filter.post_id = p.post_id
        AND pc_filter.author_id = $1
        AND pc_filter.author_org_id IS NULL
    )
    AND p.visibility = 'public'
    AND p.author_id != $1`;

    if (cursorCreatedAt && cursorPostId) {
      whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})`;
      params.push(cursorCreatedAt, cursorPostId);
      idx += 2;
    }

    params.push(limit);
    const limitIdx = idx;

    const userParamIdx = params.length + 1;
    params.push(currentUserId);

    const query = `
      SELECT
        p.post_id,
        p.content,
        p.created_at,
        p.visibility,
        p.post_type,

        COALESCE(p.author_org_id, u.user_id) AS author_id,
        COALESCE(comp.name, u.full_name) AS author_name,
        COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
        COALESCE(comp.slug, u.account_name) AS author_slug,
        (p.author_org_id IS NOT NULL) AS is_organization_post,
        CASE WHEN p.author_org_id IS NOT NULL THEN comp.headline ELSE u.headline END AS author_headline,

        pc.name AS category_name,
        p.location,

        COALESCE(pm.media, '[]'::json) AS media,
        COALESCE(lc.like_count, 0) AS like_count,

        EXISTS(SELECT 1 FROM active_post_likes pl_me WHERE pl_me.post_id = p.post_id AND pl_me.user_id = $${userParamIdx} AND pl_me.org_id IS NULL) AS is_liked,
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
        ) AS is_reposted_with_thoughts,
        (
            SELECT sp_rep.post_id FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
            LIMIT 1
        ) AS repost_id,
        (
            SELECT COALESCE(
                json_agg(json_build_object(
                    'username', COALESCE(comp_like.slug, u_like.account_name),
                    'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                )),
                '[]'::json
            )
            FROM (
                SELECT pl_sample.user_id, pl_sample.org_id
                FROM active_post_likes pl_sample
                WHERE pl_sample.post_id = p.post_id
                  AND pl_sample.user_id IS NOT NULL
                  AND pl_sample.user_id != $${userParamIdx}::uuid
                ORDER BY pl_sample.created_at DESC
                LIMIT 3
            ) sub
            LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
            LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
        ) AS liked_users,
        EXISTS(SELECT 1 FROM active_post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_id = $${userParamIdx} AND pc_me.author_org_id IS NULL) AS is_commented,

        EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL) AS is_saved,
        
        COALESCE(cc.comment_count, 0) AS comment_count,

        -- The most recent comment by target user on this post
        (
          SELECT json_build_object(
            'comment_id', mc.comment_id,
            'content', mc.content,
            'created_at', mc.created_at,
            'author_id', mc.author_id,
            'author_name', mc_u.full_name,
            'author_avatar', mc_u.avatar_url,
            'author_title', mc_u.headline,
            'like_count', (SELECT COUNT(*) FROM active_comment_likes cl WHERE cl.comment_id = mc.comment_id)::int,
            'is_liked', EXISTS(SELECT 1 FROM active_comment_likes cl WHERE cl.comment_id = mc.comment_id AND cl.user_id = $${userParamIdx} AND cl.org_id IS NULL),
            'reply_count', (SELECT COUNT(*) FROM active_post_comments rc WHERE rc.parent_id = mc.comment_id)::int
          )
          FROM active_post_comments mc
          JOIN active_users mc_u ON mc_u.user_id = mc.author_id
          WHERE mc.post_id = p.post_id
            AND mc.author_id = $1
            AND mc.author_org_id IS NULL
          ORDER BY mc.created_at DESC
          LIMIT 1
        ) AS their_comment

      FROM posts p
      JOIN active_users u ON u.user_id = p.author_id
      LEFT JOIN organizations comp ON comp.org_id = p.author_org_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id
      LEFT JOIN (
          SELECT pm.post_id, json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'media_type', pm.media_type)) AS media
          FROM post_media pm GROUP BY pm.post_id
      ) pm ON pm.post_id = p.post_id
      LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM active_post_likes GROUP BY post_id) lc ON lc.post_id = p.post_id
      LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM active_post_comments GROUP BY post_id) cc ON cc.post_id = p.post_id
      ${whereClause}
      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${limitIdx}
    `;

    const { rows } = await pool.query(query, params);
    const last = rows[rows.length - 1];

    const hydratedRows = await hydrateShareCounts(rows);

    res.json({
      posts: hydratedRows,
      nextCursor: last
        ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id }
        : null,
    });
  } catch (err) {
    console.error("Get public profile commented posts error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * DELETE /api/users/account
 * Purpose: Permanent account deletion
 */
exports.deleteAccount = async (req, res) => {
  const userId = req.user.sub;
  const { password, idToken, companyIdsToDelete = [] } = req.body;



  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Fetch user record
    const userRes = await client.query(
      "SELECT user_id, email, recovery_email, full_name, password_hash, google_id FROM users WHERE user_id = $1",
      [userId]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRes.rows[0];

    // 2. Identity verification — password user OR Google user
    let isAuthenticated = false;

    if (user.password_hash) {
      if (!password) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Password is required to delete your account" });
      }
      const isValid = await comparePassword(password, user.password_hash);
      if (isValid) {
        isAuthenticated = true;
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid password" });
      }
    } else if (user.google_id) {
      if (!idToken) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Google re-authentication is required to delete your account." });
      }
      try {
        const googlePayload = await verifyGoogleToken(idToken);
        if (googlePayload.googleId === user.google_id) {
          isAuthenticated = true;
        } else {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Google account does not match this account." });
        }
      } catch {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid Google token. Please re-authenticate and try again." });
      }
    } else {
      isAuthenticated = true;
    }

    if (!isAuthenticated) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Authentication is required to delete your account" });
    }

    // 3. Block deletion if owner of a company not selected for deletion
    console.log(`[DeleteAccount] Checking owned companies against companyIdsToDelete:`, companyIdsToDelete);
    const ownedCompanies = await client.query(
      `SELECT c.org_id, c.name
       FROM organizations c
       WHERE c.created_by = $1
         AND c.is_deleted = FALSE`,
      [userId]
    );

    const missingDeletions = ownedCompanies.rows.filter(c => !companyIdsToDelete.includes(c.org_id));

    if (missingDeletions.length > 0) {
      throw new AppError(
        `You are the sole owner of "${missingDeletions[0].name}". Please transfer ownership or select it for deletion alongside your account.`,
        400
      );
    }

    // 4. Create Deletion Batch
    const batchType = companyIdsToDelete.length > 0 ? 'USER_AND_COMPANIES' : 'USER';
    const batchRes = await client.query(
      `INSERT INTO deletion_batches (created_by, type) VALUES ($1, $2) RETURNING batch_id`,
      [userId, batchType]
    );
    const batchId = batchRes.rows[0].batch_id;

    // 5. Schedule soft deletion for user (40 days from now)
    const deletionExecuteAt = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    await client.query(
      `UPDATE users
       SET is_deleted = TRUE, deleted_at = NOW(), deletion_scheduled_at = NOW(), deletion_execute_at = $1, deletion_batch_id = $2
       WHERE user_id = $3`,
      [deletionExecuteAt, batchId, userId]
    );

    // 6. Soft delete selected companies
    if (companyIdsToDelete.length > 0) {
      await client.query(
        `UPDATE organizations
         SET is_deleted = TRUE, deleted_at = NOW(), deletion_scheduled_at = NOW(), deletion_execute_at = $1, deletion_batch_id = $2
         WHERE org_id = ANY($3) AND created_by = $4`,
        [deletionExecuteAt, batchId, companyIdsToDelete, userId]
      );
    }

    // 5. Revoke all active sessions from DB and collect session IDs for blacklisting
    const sessionsRes = await client.query(
      "DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING session_id",
      [userId]
    );
    const sessionIds = sessionsRes.rows.map((r) => r.session_id);

    // 6. Generate a cryptographically secure restore token (raw + hashed)
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    await client.query(
      `INSERT INTO account_restoration_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, deletionExecuteAt]
    );

    // 7. Transfer group chat admin roles if this user was a group admin
    const GroupChatService = require("../../services/groupChat.service");
    await GroupChatService.handleAdminDeactivationOrDeletion(userId, client);

    await client.query("COMMIT");

    // 7. Blacklist all session JWTs in Redis (non-blocking, outside transaction)
    if (redisClient.isOpen && sessionIds.length > 0) {
      await Promise.allSettled(
        sessionIds.map((sid) => redisClient.setEx(`revoked_session:${sid}`, 900, "1"))
      );
    }

    // 8. Disconnect all active sockets for this user (one per session)
    if (sessionIds.length > 0) {
      Promise.allSettled(
        sessionIds.map((sid) => socketService.disconnectUserSession(userId, sid))
      ).catch((err) => console.error("[deleteAccount] Socket disconnect failed:", err));
    }

    // Broadcast user deletion socket events to invalidate real-time chat and post caches for other clients
    if (socketService?.io) {
      socketService.io.emit('user_deleted', { userId });
      socketService.io.emit('USER_DELETED', { userId });
      socketService.io.emit('user_deactivated', { userId });
      socketService.io.emit('USER_DEACTIVATED', { userId });
      socketService.io.emit('account_state_changed', { userId, type: 'user', action: 'deleted' });
    }

    // 9. Send recovery email to recovery_email and/or primary email (non-blocking)
    const recipientEmails = Array.from(
      new Set([user.recovery_email, user.email].filter((e) => Boolean(e) && typeof e === "string" && e.trim() !== ""))
    );

    const baseUrl = req.get('origin') || req.headers.referer || process.env.CLIENT_URL || user.client_origin || 'http://localhost:3000';

    for (const recipientEmail of recipientEmails) {
      sendAccountDeletionEmail(recipientEmail, user.full_name, rawToken, deletionExecuteAt, baseUrl).catch((err) => {
        console.error(`[deleteAccount] Failed to send recovery email to ${recipientEmail}:`, err.message || err);
      });
    }

    // 10. Clear cookies
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
    });

    return res.status(200).json({
      message: "Account scheduled for deletion. Check your email for a restoration link.",
      deletionDate: deletionExecuteAt,
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Account deletion error:", err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    return res.status(500).json({ message: "Internal server error during account deletion" });
  } finally {
    if (client) client.release();
  }
};
// ─── Restore Account ────────────────────────────────────────────────────────────

/**
 * POST /users/account/restore
 * Public route — validates a restoration token and cancels scheduled deletion.
 */
exports.restoreAccount = async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: "Restoration token is required" });
  }


  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query(
      `SELECT art.id, art.user_id, art.expires_at, art.used_at
       FROM account_restoration_tokens art
       WHERE art.token_hash = $1`,
      [tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid restoration link. Please request a new one." });
    }

    const tokenRow = tokenRes.rows[0];

    if (tokenRow.used_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This restoration link has already been used. Your account is already restored." });
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This restoration link has expired. Please request a new one from the login page." });
    }

    // Get user and their batch ID
    const userRes = await client.query(
      `SELECT deletion_batch_id FROM users WHERE user_id = $1`,
      [tokenRow.user_id]
    );
    const batchId = userRes.rowCount > 0 ? userRes.rows[0].deletion_batch_id : null;

    await client.query(
      `UPDATE users SET is_deleted = FALSE, deleted_at = NULL, deletion_scheduled_at = NULL, deletion_execute_at = NULL, deletion_batch_id = NULL WHERE user_id = $1`,
      [tokenRow.user_id]
    );

    // Clear deletion schedule on linked companies if a batch exists
    if (batchId) {
      await client.query(
        `UPDATE organizations 
         SET is_deleted = FALSE, deleted_at = NULL, deletion_scheduled_at = NULL, deletion_execute_at = NULL, deletion_batch_id = NULL 
         WHERE deletion_batch_id = $1`,
        [batchId]
      );
    }

    // Mark token as used
    await client.query(
      `UPDATE account_restoration_tokens SET used_at = NOW() WHERE id = $1`,
      [tokenRow.id]
    );

    // Reset unread count for group conversations by updating last_read_at to NOW()
    await client.query(`
      UPDATE conversation_participants cp
      SET last_read_at = NOW()
      FROM conversations c
      WHERE cp.conversation_id = c.conversation_id
        AND c.is_group = TRUE
        AND cp.user_id = $1
        AND cp.left_at IS NULL
    `, [tokenRow.user_id]);

    await client.query("COMMIT");

    // Broadcast user reactivation socket events
    if (socketService?.io) {
      socketService.io.emit('user_reactivated', { userId: tokenRow.user_id });
      socketService.io.emit('USER_REACTIVATED', { userId: tokenRow.user_id });
      socketService.io.emit('account_state_changed', { userId: tokenRow.user_id, type: 'user', action: 'restored' });
    }

    return res.status(200).json({ message: "Your account has been restored. You can now log in." });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Restore account error:", err);
    return res.status(500).json({ message: "Failed to restore account. Please try again." });
  } finally {
    if (client) client.release();
  }
};

// ─── Resend Recovery Email ───────────────────────────────────────────────────────

/**
 * POST /users/account/resend-recovery
 * Public route — rate-limited. Sends a fresh recovery email.
 * Always returns 200 to avoid leaking whether an email exists.
 */
exports.resendRecoveryEmail = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  // Always respond 200 — never reveal whether the email exists
  res.status(200).json({ message: "If an account with this email is pending deletion, a new recovery email has been sent." });

  // Process async — response already sent
  (async () => {
    try {


      const userRes = await pool.query(
        `SELECT user_id, email, recovery_email, full_name, deletion_execute_at
         FROM users WHERE (LOWER(email) = $1 OR LOWER(recovery_email) = $1) AND deletion_execute_at IS NOT NULL`,
        [email.toLowerCase()]
      );

      if (userRes.rowCount === 0) {
        console.log(`[resendRecoveryEmail] No account pending deletion found for email: ${email}`);
        return;
      }

      const user = userRes.rows[0];

      // Invalidate all existing unused tokens for this user
      await pool.query(
        `UPDATE account_restoration_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.user_id]
      );

      // Generate a new token
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      await pool.query(
        `INSERT INTO account_restoration_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.user_id, tokenHash, user.deletion_execute_at]
      );

      const recipientEmails = Array.from(
        new Set([user.recovery_email, user.email].filter((e) => Boolean(e) && typeof e === "string" && e.trim() !== ""))
      );

      const baseUrl = req.get('origin') || req.headers.referer || process.env.CLIENT_URL || user.client_origin || 'http://localhost:3000';

      for (const recipientEmail of recipientEmails) {
        await sendAccountDeletionEmail(recipientEmail, user.full_name, rawToken, user.deletion_execute_at, baseUrl).catch((err) => {
          console.error(`[resendRecoveryEmail] Failed to send recovery email to ${recipientEmail}:`, err.message || err);
        });
      }
    } catch (err) {
      console.error("[resendRecoveryEmail] Background processing error:", err);
    }
  })();
};




/**
 * GET /api/users/suggested
 * Purpose: Provide user recommendations for new accounts or discovery
 */
exports.getSuggestedUsers = async (req, res) => {
  const currentUserId = req.user.sub;
  const { excludeJobId, forTagging } = req.query;

  try {
    const params = [currentUserId];
    let excludeJobFilter = '';
    let taggingPrivacyFilter = '';

    if (excludeJobId) {
      params.push(excludeJobId);
      excludeJobFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM job_offers jo 
          WHERE jo.job_id = $2 AND jo.user_id = u.user_id
          AND jo.status IN ('pending', 'accepted', 'declined')
        )
      `;
    }

    if (forTagging === "true" || forTagging === "1") {
      taggingPrivacyFilter = `
        AND u.tag_permission != 'noone'
        AND u.tag_permission != 'no_one'
        AND (
          u.tag_permission IS NULL 
          OR u.tag_permission IN ('everyone')
          OR (
            u.tag_permission IN ('connections_only', 'connections')
            AND EXISTS (
              SELECT 1 FROM connections c 
              WHERE (c.user_id = $1 AND c.connected_user_id = u.user_id) 
                 OR (c.user_id = u.user_id AND c.connected_user_id = $1)
            )
          )
          OR (
            u.tag_permission IN ('followers_only', 'followers')
            AND EXISTS (
              SELECT 1 FROM followers f 
              WHERE f.follower_id = $1 AND f.following_id = u.user_id
            )
          )
        )
      `;
    }

    const query = `
      SELECT 
        u.user_id AS id,
        u.full_name,
        u.account_name,
        u.avatar_url,
        u.headline,
        p.account_type,
        (SELECT COUNT(*) FROM followers WHERE following_id = u.user_id) + (SELECT COUNT(*) FROM organization_user_follows cf JOIN organizations c ON cf.org_id = c.org_id WHERE cf.user_id = u.user_id AND c.is_deleted = FALSE) as followers_count
      FROM active_users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.is_deactivated = FALSE
      AND u.full_name IS NOT NULL AND TRIM(u.full_name) <> ''
      AND u.account_name IS NOT NULL AND TRIM(u.account_name) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = u.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE b.is_org_block = false
          AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
            OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
      )
      ${excludeJobFilter}
      ${taggingPrivacyFilter}
      ORDER BY followers_count DESC, u.created_at DESC
      LIMIT 15
    `;

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Get suggested users error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/users/search-history
 * Purpose: Fetch the top 6 recent searches for the authenticated user with live profile data
 */
exports.getSearchHistory = async (req, res) => {
  const userId = req.user.sub;
  
  try {
    const query = `
      SELECT 
        sh.id, 
        CASE 
          WHEN u.user_id IS NOT NULL THEN u.full_name
          WHEN o.org_id IS NOT NULL THEN o.name
          ELSE sh.query_text
        END as query, 
        CASE 
          WHEN u.user_id IS NOT NULL THEN
            jsonb_build_object(
              'id', u.user_id,
              'full_name', u.full_name,
              'name', u.full_name,
              'account_name', u.account_name,
              'username', u.account_name,
              'avatar_url', u.avatar_url,
              'avatar', u.avatar_url,
              'headline', u.headline,
              'account_type', COALESCE(u.user_type, 'USER'),
              'type', 'USER',
              'slug', NULL,
              'industry', NULL,
              'tag_permission', COALESCE(u.tag_permission, 'everyone')
            )
          WHEN o.org_id IS NOT NULL THEN
            jsonb_build_object(
              'id', o.org_id,
              'full_name', o.name,
              'name', o.name,
              'account_name', o.slug,
              'username', o.slug,
              'avatar_url', o.logo_url,
              'avatar', o.logo_url,
              'headline', o.headline,
              'account_type', 'COMPANY',
              'type', 'COMPANY',
              'slug', o.slug,
              'industry', o.industry,
              'tag_permission', 'everyone'
            )
          ELSE sh.profile_snapshot
        END as "profileSnapshot",
        sh.created_at as "createdAt"
      FROM user_search_history sh
      LEFT JOIN active_users u ON sh.query_normalized = ('user:' || u.user_id::text)
      LEFT JOIN active_organizations o ON sh.query_normalized = ('user:' || o.org_id::text)
      WHERE sh.user_id = $1
        AND (sh.query_normalized NOT LIKE 'user:%' OR u.user_id IS NOT NULL OR o.org_id IS NOT NULL)
      ORDER BY sh.created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    
    // Defensive parsing for legacy stringified snapshots
    const processedRows = result.rows.map(row => {
      let profileSnapshot = row.profileSnapshot;
      if (typeof profileSnapshot === 'string') {
        try {
          profileSnapshot = JSON.parse(profileSnapshot);
        } catch (e) {
          console.error("Error parsing profileSnapshot string:", e);
        }
      }
      return { ...row, profileSnapshot };
    });

    res.status(200).json({ success: true, data: processedRows });
  } catch (err) {
    console.error("Get search history error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


/**
 * POST /api/users/search-history
 * Purpose: Save or update a recent search query
 */
exports.saveSearchHistory = async (req, res) => {
  const userId = req.user.sub;
  const { query, profileSnapshot } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, message: "Valid search query is required" });
  }

  const queryText = query.trim();
  let queryNormalized = queryText.toLowerCase();
  
  const snapshotJson = profileSnapshot ? JSON.stringify(profileSnapshot) : null;
  
  // Make queryNormalized unique by profile ID to prevent collisions between users with identical names
  if (profileSnapshot && profileSnapshot.id) {
    queryNormalized = `user:${profileSnapshot.id}`;
  } else {
    queryNormalized = `query:${queryNormalized}`;
  }

  try {
    // Upsert query: if it exists, update the timestamp to move it to the top
    const upsertQuery = `
      INSERT INTO user_search_history (user_id, query_text, query_normalized, profile_snapshot, created_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id, query_normalized) 
      DO UPDATE SET created_at = EXCLUDED.created_at, query_text = EXCLUDED.query_text, profile_snapshot = EXCLUDED.profile_snapshot
      RETURNING id, query_text as query, profile_snapshot as "profileSnapshot", created_at as "createdAt"
    `;
    const saved = await pool.query(upsertQuery, [userId, queryText, queryNormalized, snapshotJson]);

    res.status(201).json({ success: true, data: saved.rows[0] });
  } catch (err) {
    console.error("Save search history error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * DELETE /api/users/search-history/:id
 * Purpose: Remove a specific search history item
 */
exports.removeSearchHistory = async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  try {
    const query = `
      DELETE FROM user_search_history
      WHERE id = $1 AND user_id = $2
    `;
    await pool.query(query, [id, userId]);
    res.status(200).json({ success: true, message: "Search history item removed" });
  } catch (err) {
    console.error("Remove search history error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * DELETE /api/users/search-history
 * Purpose: Clear all search history for the user
 */
exports.clearSearchHistory = async (req, res) => {
  const userId = req.user.sub;

  try {
    const query = `
      DELETE FROM user_search_history
      WHERE user_id = $1
    `;
    await pool.query(query, [userId]);
    res.status(200).json({ success: true, message: "Search history cleared" });
  } catch (err) {
    console.error("Clear search history error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};