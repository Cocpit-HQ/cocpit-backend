const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");

const { checkOrgPermission } = require("../../core/utils/rbac");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
        // The middleware (requireOrgActorPermission) already handled the mismatch check.
        // In non-strict mode, prefer the actor's orgId (from headers) as the authoritative source.
        console.warn(
            `[Analytics] orgId mismatch resolved: using actor orgId=${actorOrgId} (url param was: ${fallbackOrgId})`
        );
        return actorOrgId;
    }

    return actorOrgId || fallbackOrgId;
};


exports.getOverview = async (req, res) => {
    let companyId;
    try {
        companyId = getRequestedOrganizationActorId(req, req.params.orgId);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const canView = req.actor?.type === "ORGANIZATION"
            ? hasActorPermission(req.actor.permissions || [], "VIEW_ANALYTICS")
            : await checkOrgPermission(client, companyId, userId, 'VIEW_ANALYTICS');
        if (!canView) {
            throw new AppError("Forbidden: You do not have permission to view analytics", 403);
        }

        // 1. Follower Count & Growth (Last 30 days)
        const followerCountRes = await client.query(
            `SELECT COUNT(*) FROM organization_followers WHERE org_id = $1`,
            [companyId]
        );
        const totalFollowers = parseInt(followerCountRes.rows[0].count);

        // Growth: Group by day for last 30 days
        const growthRes = await client.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count 
             FROM organization_followers 
             WHERE org_id = $1 AND created_at > NOW() - INTERVAL '30 days'
             GROUP BY DATE(created_at) 
             ORDER BY DATE(created_at) ASC`,
            [companyId]
        );

        // 2. Profile Views (From Audit Logs: action='VIEW')
        // We will add logging to getCompany to populate this
        const viewsRes = await client.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count 
             FROM audit_logs 
             WHERE entity_id = $1 AND entity_type = 'ORGANIZATION' AND action = 'VIEW'
             AND created_at > NOW() - INTERVAL '30 days'
             GROUP BY DATE(created_at)
             ORDER BY DATE(created_at) ASC`,
            [companyId]
        );

        const totalViewsRes = await client.query(
            `SELECT COUNT(*) FROM audit_logs WHERE entity_id = $1 AND entity_type = 'ORGANIZATION' AND action = 'VIEW'`,
            [companyId]
        );
        const totalViews = parseInt(totalViewsRes.rows[0].count);

        res.json({
            followers: {
                total: totalFollowers,
                history: growthRes.rows
            },
            views: {
                total: totalViews,
                history: viewsRes.rows
            }
        });
    } catch (err) {
        console.error("Analytics Overview Error:", err);
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getEngagement = async (req, res) => {
    let companyId;
    try {
        companyId = getRequestedOrganizationActorId(req, req.params.orgId);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const canView = req.actor?.type === "ORGANIZATION"
            ? hasActorPermission(req.actor.permissions || [], "VIEW_ANALYTICS")
            : await checkOrgPermission(client, companyId, userId, 'VIEW_ANALYTICS');
        if (!canView) {
            throw new AppError("Forbidden: You do not have permission to view analytics", 403);
        }

        // 1. Total Likes & Comments on Company Posts
        const statsRes = await client.query(
            `SELECT 
                (SELECT COUNT(*) FROM active_post_likes WHERE org_id = $1) as company_likes_given, 
                (SELECT COUNT(*) FROM active_post_comments WHERE author_org_id = $1) as company_comments_given,
                -- Received Engagement (on posts authored by company)
                -- We look for posts where author_org_id = companyId
                (SELECT COUNT(*) FROM active_post_likes pl 
                 JOIN posts p ON pl.post_id = p.post_id 
                 WHERE p.author_org_id = $1) as likes_received,
                (SELECT COUNT(*) FROM active_post_comments pc
                 JOIN posts p ON pc.post_id = p.post_id
                 WHERE p.author_org_id = $1) as comments_received
            `,
            [companyId]
        );

        // 2. Top Performing Posts
        const topPostsRes = await client.query(
            `SELECT p.post_id, p.content, p.created_at,
                (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id) as like_count,
                (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id) as comment_count
             FROM posts p
             WHERE p.author_org_id = $1
             ORDER BY (
                (SELECT COUNT(*) FROM active_post_likes pl2 WHERE pl2.post_id = p.post_id) +
                (SELECT COUNT(*) FROM active_post_comments pc2 WHERE pc2.post_id = p.post_id)
             ) DESC
             LIMIT 5`,
            [companyId]
        );

        res.json({
            stats: statsRes.rows[0],
            topPosts: topPostsRes.rows
        });
    } catch (err) {
        console.error("Analytics Engagement Error:", err);
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getJobs = async (req, res) => {
    let companyId;
    try {
        companyId = getRequestedOrganizationActorId(req, req.params.orgId);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        const canView = req.actor?.type === "ORGANIZATION"
            ? hasActorPermission(req.actor.permissions || [], "VIEW_ANALYTICS")
            : await checkOrgPermission(client, companyId, userId, 'VIEW_ANALYTICS');
        if (!canView) {
            throw new AppError("Forbidden: You do not have permission to view job analytics", 403);
        }

        // 1. Identify Jobs
        // Strategy: Match by company_name corresponding to this company
        const companyRes = await client.query(`SELECT name FROM organizations WHERE org_id = $1`, [companyId]);
        const companyName = companyRes.rows[0].name;

        // 2. Aggregate Stats
        const jobsStatsRes = await client.query(
            `SELECT 
                COUNT(*) as total_jobs,
                SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active_jobs,
                (SELECT COUNT(*) 
                 FROM job_applications ja 
                 JOIN jobs j ON ja.job_id = j.job_id 
                 WHERE j.company_name = $1) as total_applications
             FROM jobs 
             WHERE company_name = $1`,
            [companyName]
        );

        res.json({
            overview: jobsStatsRes.rows[0]
        });

    } catch (err) {
        console.error("Analytics Jobs Error:", err);
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getAuditLogs = async (req, res) => {
    let companyId;
    try {
        companyId = getRequestedOrganizationActorId(req, req.params.orgId);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
    const userId = req.user.sub;
    const { page = 1, limit = 20, action, actorId } = req.query;
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
        // PERMISSIONS: Only OWNER and ADMIN can view audit logs (requires MANAGE_COMPANY)
        const canViewAudit = req.actor?.type === "ORGANIZATION"
            ? hasActorPermission(req.actor.permissions || [], "MANAGE_COMPANY")
            : await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY');
        if (!canViewAudit) throw new AppError("Forbidden: Only Admins can view audit logs", 403);

        // Build Query
        let query = `
            SELECT al.*, u.full_name as actor_name, u.email as actor_email, u.avatar_url as actor_avatar
            FROM audit_logs al
            LEFT JOIN active_users u ON al.actor_id = u.user_id
            WHERE al.entity_id = $1 AND al.entity_type = 'ORGANIZATION'
        `;
        const params = [companyId];
        let paramIdx = 2;

        if (action) {
            query += ` AND al.action = $${paramIdx}`;
            params.push(action);
            paramIdx++;
        }

        if (actorId) {
            query += ` AND al.actor_id = $${paramIdx}`;
            params.push(actorId);
            paramIdx++;
        }

        query += ` ORDER BY al.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(limit, offset);

        const result = await client.query(query, params);

        // Get Total Count (for pagination)
        // Simplified count query
        let countQuery = `SELECT COUNT(*) FROM audit_logs WHERE entity_id = $1 AND entity_type = 'ORGANIZATION'`;
        const countParams = [companyId];
        let countParamIdx = 2;
        if (action) {
            countQuery += ` AND action = $${countParamIdx}`;
            countParams.push(action);
            countParamIdx++;
        }
        if (actorId) {
            countQuery += ` AND actor_id = $${countParamIdx}`;
            countParams.push(actorId);
            countParamIdx++;
        }

        const countRes = await client.query(countQuery, countParams);

        res.json({
            data: result.rows,
            meta: {
                total: parseInt(countRes.rows[0].count),
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });

    } catch (err) {
        console.error("Get Audit Logs Error:", err);
        if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};
