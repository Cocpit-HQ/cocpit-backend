const pool = require("../../core/db/pool");
const dateFns = require("date-fns");
const { resolveDateRange, generateDateRange, formatNumber, calculateTrend, formatIndustryName } = require("./analytics.helpers");

const getPostAnalyticsData = async (postId, userId, { filter, startDate, endDate }) => {
    // 1. Resolve Dates
    const userRes = await pool.query('SELECT created_at FROM users WHERE user_id = $1', [userId]);
    if (userRes.rowCount === 0) throw new Error("User not found");
    const userCreatedAt = userRes.rows[0].created_at;
    const { start, end } = resolveDateRange(filter, startDate, endDate, userCreatedAt);

    // 2. Fetch Post Details
    const postRes = await pool.query(`
        SELECT p.title, p.content, p.post_type, p.created_at,
        (SELECT url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) as media_url
        FROM posts p
        WHERE p.post_id = $1
    `, [postId]);

    if (postRes.rowCount === 0) throw new Error("Post not found");
    const p = postRes.rows[0];

    let plainTextContent = p.content ? p.content.replace(/<[^>]*>?/gm, '').trim() : '';
    let title = p.title;
    if (!title) {
        title = plainTextContent ? plainTextContent : 'No caption';
    }

    let fallbackIcon = 'lucide:type';
    const pType = (p.post_type || '').toLowerCase();
    if (pType.includes('article')) fallbackIcon = 'solar:document-add-linear';
    else if (pType.includes('poll')) fallbackIcon = 'fluent:poll-16-regular';
    else if (pType.includes('image') || pType.includes('video')) fallbackIcon = 'stash:image';

    const postDetails = {
        title,
        type: p.post_type ? p.post_type.charAt(0).toUpperCase() + p.post_type.slice(1).toLowerCase() + ' post' : 'Post',
        publishedAt: dateFns.format(new Date(p.created_at), 'MMM dd yyyy').toLowerCase(),
        contentSnippet: plainTextContent ? (plainTextContent.length > 80 ? plainTextContent.substring(0, 80) + '...' : plainTextContent) : '',
        mediaUrl: p.media_url || null,
        fallbackIcon: p.media_url ? null : fallbackIcon
    };

    // 3. Content Performance
    const perfRes = await pool.query(`
        SELECT 
            COALESCE(SUM(impressions), 0) as views,
            COALESCE(SUM(likes), 0) as likes,
            COALESCE(SUM(comments), 0) as comments,
            COALESCE(SUM(shares), 0) as shares,
            COALESCE(SUM(saves), 0) as saves
        FROM post_analytics_daily
        WHERE post_id = $1 AND date >= DATE($2) AND date <= DATE($3)
    `, [postId, start, end]);

    const perf = perfRes.rows[0];
    const views = parseInt(perf.views, 10);
    const likes = parseInt(perf.likes, 10);
    const comments = parseInt(perf.comments, 10);
    const shares = parseInt(perf.shares, 10);
    const saves = parseInt(perf.saves, 10);

    const totalEngagements = likes + comments + shares + saves;
    let engagementRate = 0;
    if (views > 0) {
        engagementRate = (totalEngagements / views) * 100;
    }

    const performance = {
        impressions: views,
        likes: likes,
        comments: comments,
        shares: shares,
        saves: saves,
        engagementRate: Number(engagementRate.toFixed(1)) + '%'
    };

    // 4. Reach Chart (Daily Impressions)
    const rangeDays = dateFns.differenceInDays(end, start);
    let chartLabels = [];
    let chartData = [];

    if (rangeDays <= 31) {
        const allDates = generateDateRange(start, end);
        const dailyViewsRes = await pool.query(`
            SELECT DATE(date) as d, SUM(impressions) as v 
            FROM post_analytics_daily 
            WHERE post_id = $1 AND date >= DATE($2) AND date <= DATE($3)
            GROUP BY DATE(date)
        `, [postId, start, end]);
        
        const viewsMap = {};
        dailyViewsRes.rows.forEach(r => {
            viewsMap[dateFns.format(new Date(r.d), 'yyyy-MM-dd')] = parseInt(r.v, 10);
        });

        allDates.forEach(d => {
            chartLabels.push(dateFns.format(new Date(d), 'dd MMM'));
            chartData.push(viewsMap[d] || 0);
        });
    } else {
        const weeklyRes = await pool.query(`
            SELECT DATE_TRUNC('week', date) as week_start, SUM(impressions) as v 
            FROM post_analytics_daily 
            WHERE post_id = $1 AND date >= DATE($2) AND date <= DATE($3)
            GROUP BY week_start ORDER BY week_start
        `, [postId, start, end]);
        
        weeklyRes.rows.forEach(r => {
            const ws = new Date(r.week_start);
            const we = dateFns.addDays(ws, 6);
            chartLabels.push(`${dateFns.format(ws, 'dd MMM')}-${dateFns.format(we, 'dd MMM')}`);
            chartData.push(parseInt(r.v, 10));
        });
    }

    // 5. Direct Impact
    const getDirectImpactCount = async (query, params) => {
        const res = await pool.query(query, params);
        return parseInt(res.rows[0].count, 10);
    };

    const profileVisits = await getDirectImpactCount(`SELECT COUNT(1) as count FROM profile_views WHERE source_post_id = $1 AND view_date >= DATE($2) AND view_date <= DATE($3)`, [postId, start, end]);
    const newFollowers = await getDirectImpactCount(`
        SELECT (
            (SELECT COUNT(1) FROM followers WHERE source_post_id = $1 AND created_at >= $2 AND created_at <= $3) +
            (SELECT COUNT(1) FROM organization_followers WHERE source_post_id = $1 AND created_at >= $2 AND created_at <= $3) +
            (SELECT COUNT(1) FROM organization_user_follows WHERE source_post_id = $1 AND created_at >= $2 AND created_at <= $3) +
            (SELECT COUNT(1) FROM organization_org_follows WHERE source_post_id = $1 AND created_at >= $2 AND created_at <= $3)
        ) as count
    `, [postId, start, end]);
    const organizationViews = await getDirectImpactCount(`
        SELECT COUNT(1) as count FROM (
            SELECT DISTINCT DATE(view_date), COALESCE(viewer_org_id::text, viewer_id::text, impression_id::text)
            FROM post_impressions 
            WHERE post_id = $1 AND viewer_org_id IS NOT NULL AND view_date >= DATE($2) AND view_date <= DATE($3)
        ) sub
    `, [postId, start, end]);

    // Calculate Averages for vsAvg
    // Get total posts by user
    const totalPostsRes = await pool.query(`SELECT COUNT(1) as count FROM posts WHERE author_id = $1`, [userId]);
    const totalPosts = Math.max(parseInt(totalPostsRes.rows[0].count, 10), 1); // Avoid div by zero
    
    // Average profile visits from all posts
    const allVisitsRes = await getDirectImpactCount(`
        SELECT COUNT(1) as count FROM profile_views pv 
        JOIN posts p ON p.post_id = pv.source_post_id 
        WHERE p.author_id = $1 AND pv.view_date >= DATE($2) AND pv.view_date <= DATE($3)
    `, [userId, start, end]);
    const avgVisits = allVisitsRes / totalPosts;

    const allFollowersRes = await getDirectImpactCount(`
        SELECT (
            (SELECT COUNT(1) FROM followers f JOIN posts p ON p.post_id = f.source_post_id WHERE p.author_id = $1 AND f.created_at >= $2 AND f.created_at <= $3) +
            (SELECT COUNT(1) FROM organization_followers ofol JOIN posts p ON p.post_id = ofol.source_post_id WHERE p.author_id = $1 AND ofol.created_at >= $2 AND ofol.created_at <= $3) +
            (SELECT COUNT(1) FROM organization_user_follows ouf JOIN posts p ON p.post_id = ouf.source_post_id WHERE p.author_id = $1 AND ouf.created_at >= $2 AND ouf.created_at <= $3) +
            (SELECT COUNT(1) FROM organization_org_follows oof JOIN posts p ON p.post_id = oof.source_post_id WHERE p.author_id = $1 AND oof.created_at >= $2 AND oof.created_at <= $3)
        ) as count
    `, [userId, start, end]);
    const avgFollowers = allFollowersRes / totalPosts;

    const allOrgViewsRes = await getDirectImpactCount(`
        SELECT COUNT(1) as count FROM (
            SELECT DISTINCT DATE(pi.view_date), COALESCE(pi.viewer_org_id::text, pi.viewer_id::text, pi.impression_id::text)
            FROM post_impressions pi
            JOIN posts p ON p.post_id = pi.post_id 
            WHERE p.author_id = $1 AND pi.viewer_org_id IS NOT NULL AND pi.view_date >= DATE($2) AND pi.view_date <= DATE($3)
        ) sub
    `, [userId, start, end]);
    const avgOrgViews = allOrgViewsRes / totalPosts;

    // Helper for vsAvg trend string
    const formatVsAvg = (current, avg) => {
        if (avg === 0 && current === 0) return "Stable";
        if (avg === 0 && current > 0) return "+100%";
        const diff = current - avg;
        const percent = (diff / avg) * 100;
        const rounded = Number(percent.toFixed(1));
        if (rounded === 0) return "Stable";
        return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
    };

    const directImpact = {
        profileVisits: { value: profileVisits, vsAvg: formatVsAvg(profileVisits, avgVisits), isPositive: profileVisits >= avgVisits },
        newFollowers: { value: newFollowers, vsAvg: formatVsAvg(newFollowers, avgFollowers), isPositive: newFollowers >= avgFollowers },
        organizationViews: { value: organizationViews, vsAvg: formatVsAvg(organizationViews, avgOrgViews), isPositive: organizationViews >= avgOrgViews }
    };

    // 6. Audience Demographics
    // We get the viewers from post_impressions
    const getDemo = async (column, limit) => {
        const res = await pool.query(`
            SELECT u.${column} AS name, COUNT(1) AS cnt
            FROM post_impressions pi
            JOIN users u ON u.user_id = pi.viewer_id
            WHERE pi.post_id = $1 AND pi.view_date >= DATE($2) AND pi.view_date <= DATE($3)
              AND u.${column} IS NOT NULL AND u.${column} != ''
            GROUP BY u.${column}
            ORDER BY cnt DESC
            LIMIT $4
        `, [postId, start, end, limit]);
        return res.rows;
    };

    // Top 4 cities
    const citiesRes = await getDemo('location_city', 4);
    // Top 4 countries
    const countriesRes = await getDemo('location_country', 4);
    
    // Top 4 industries (handling null as Other)
    const industriesRes = await pool.query(`
        SELECT COALESCE(NULLIF(p.working_industry, ''), 'Other') AS name, COUNT(1) AS cnt
        FROM post_impressions pi
        JOIN users u ON u.user_id = pi.viewer_id
        LEFT JOIN profiles p ON p.user_id = u.user_id
        WHERE pi.post_id = $1 AND pi.view_date >= DATE($2) AND pi.view_date <= DATE($3)
        GROUP BY 1
        ORDER BY cnt DESC
        LIMIT 4
    `, [postId, start, end]);

    const totalRealtimeImpressionsRes = await pool.query(`
        SELECT COUNT(1) as cnt FROM post_impressions 
        WHERE post_id = $1 AND view_date >= DATE($2) AND view_date <= DATE($3)
    `, [postId, start, end]);
    const totalViewers = Math.max(parseInt(totalRealtimeImpressionsRes.rows[0].cnt, 10), 1);
    
    const formatDemo = (rows) => rows.map(r => ({
        name: r.name,
        value: Number(Math.min((parseInt(r.cnt, 10) / totalViewers) * 100, 100).toFixed(1))
    }));

    const audienceDemographics = {
        cities: formatDemo(citiesRes),
        countries: formatDemo(countriesRes),
        industries: formatDemo(industriesRes.rows.map(r => ({ ...r, name: formatIndustryName(r.name) })))
    };

    return {
        post: postDetails,
        performance,
        reachChart: {
            labels: chartLabels,
            datasets: [{ label: "Impressions", data: chartData }],
            dateRangeStr: {
                start: dateFns.format(start, 'dd MMM yyyy').toUpperCase(),
                end: dateFns.format(end, 'dd MMM yyyy').toUpperCase()
            }
        },
        directImpact,
        audienceDemographics
    };
};

module.exports = {
    getPostAnalyticsData
};
