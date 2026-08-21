const pool = require("../../core/db/pool");
const dateFns = require("date-fns");
const { resolveDateRange, calculateTrend, generateDateRange, formatIndustryName } = require("./analytics.helpers");
const { calculateFullProfileScore } = require("../profile/profile.calculator");
const profileRepository = require("../profile/profile.repository"); // Needed for profile calculator

const getOverviewData = async (userId, { filter, startDate, endDate }) => {
    // 1. Get user's created_at for 'all_time' filter
    const userRes = await pool.query('SELECT created_at FROM users WHERE user_id = $1', [userId]);
    if (userRes.rowCount === 0) throw new Error("User not found");
    const userCreatedAt = userRes.rows[0].created_at;

    // 2. Resolve Dates
    const { start, end, previousStart, previousEnd } = resolveDateRange(filter, startDate, endDate, userCreatedAt);

    // SQL Helper: Execute a count query with date range
    const getCount = async (query, params) => {
        const res = await pool.query(query, params);
        return parseInt(res.rows[0].count, 10);
    };

    // 3. Current Period Metrics
    // We aggregate from daily tables or raw event tables
    const currentMetricsQuery = `
        SELECT 
            COALESCE(SUM(profile_views), 0) as profile_views,
            COALESCE(SUM(search_appearances), 0) as search_appearances
        FROM profile_analytics_daily 
        WHERE profile_owner_id = $1 AND date >= DATE($2) AND date <= DATE($3)
    `;
    const currAgg = await pool.query(currentMetricsQuery, [userId, start, end]);
    let currProfileViews = parseInt(currAgg.rows[0].profile_views, 10);
    let currSearchApps = parseInt(currAgg.rows[0].search_appearances, 10);

    const currConnReqs = await getCount(`SELECT COUNT(1) as count FROM connection_requests WHERE receiver_id = $1 AND created_at >= $2 AND created_at <= $3`, [userId, start, end]);
    const currFollowers = await getCount(`SELECT COUNT(1) as count FROM followers WHERE following_id = $1 AND created_at >= $2 AND created_at <= $3`, [userId, start, end]);
    const oppOffersQuery = `
        SELECT COUNT(1) as count 
        FROM job_offers jo
        WHERE jo.user_id = $1 
          AND jo.created_at >= $2 
          AND jo.created_at <= $3
          AND NOT EXISTS (
              SELECT 1 FROM profile_views pv 
              WHERE pv.profile_owner_id = jo.user_id 
                AND pv.viewer_id = jo.sent_by 
                AND pv.source = 'job_application_dashboard'
                AND pv.view_date = DATE(jo.created_at)
          )
    `;
    const currOppViewsViewsOnly = await getCount(`SELECT COUNT(1) as count FROM profile_views WHERE profile_owner_id = $1 AND source = 'job_application_dashboard' AND view_date >= DATE($2) AND view_date <= DATE($3)`, [userId, start, end]);
    const currOppViewsOffers = await getCount(oppOffersQuery, [userId, start, end]);
    const currOppViews = currOppViewsViewsOnly + currOppViewsOffers;
    
    // Resumes (Need user's resume IDs)
    const resumesRes = await pool.query('SELECT resume_id FROM user_resumes WHERE user_id = $1', [userId]);
    const resumeIds = resumesRes.rows.map(r => r.resume_id);
    let currResumeViews = 0;
    let currResumeDownloads = 0;
    
    if (resumeIds.length > 0) {
        currResumeViews = await getCount(`SELECT COUNT(1) as count FROM resume_view_events WHERE resume_id = ANY($1) AND event_type = 'view' AND created_at >= $2 AND created_at <= $3`, [resumeIds, start, end]);
        currResumeDownloads = await getCount(`SELECT COUNT(1) as count FROM resume_view_events WHERE resume_id = ANY($1) AND event_type = 'download' AND created_at >= $2 AND created_at <= $3`, [resumeIds, start, end]);
    }

    // 4. Previous Period Metrics (if applicable, for trends)
    let prevProfileViews = 0, prevSearchApps = 0, prevConnReqs = 0, prevFollowers = 0, prevOppViews = 0, prevResumeViews = 0, prevResumeDownloads = 0;
    
    if (previousStart && previousEnd) {
        const prevAgg = await pool.query(currentMetricsQuery, [userId, previousStart, previousEnd]);
        prevProfileViews = parseInt(prevAgg.rows[0].profile_views, 10);
        prevSearchApps = parseInt(prevAgg.rows[0].search_appearances, 10);

        prevConnReqs = await getCount(`SELECT COUNT(1) as count FROM connection_requests WHERE receiver_id = $1 AND created_at >= $2 AND created_at <= $3`, [userId, previousStart, previousEnd]);
        prevFollowers = await getCount(`SELECT COUNT(1) as count FROM followers WHERE following_id = $1 AND created_at >= $2 AND created_at <= $3`, [userId, previousStart, previousEnd]);
        const prevOppViewsViewsOnly = await getCount(`SELECT COUNT(1) as count FROM profile_views WHERE profile_owner_id = $1 AND source = 'job_application_dashboard' AND view_date >= DATE($2) AND view_date <= DATE($3)`, [userId, previousStart, previousEnd]);
        const prevOppViewsOffers = await getCount(oppOffersQuery, [userId, previousStart, previousEnd]);
        prevOppViews = prevOppViewsViewsOnly + prevOppViewsOffers;
        
        if (resumeIds.length > 0) {
            prevResumeViews = await getCount(`SELECT COUNT(1) as count FROM resume_view_events WHERE resume_id = ANY($1) AND event_type = 'view' AND created_at >= $2 AND created_at <= $3`, [resumeIds, previousStart, previousEnd]);
            prevResumeDownloads = await getCount(`SELECT COUNT(1) as count FROM resume_view_events WHERE resume_id = ANY($1) AND event_type = 'download' AND created_at >= $2 AND created_at <= $3`, [resumeIds, previousStart, previousEnd]);
        }
    }

    const keyMetrics = {
        profileViews: { value: currProfileViews, trend: calculateTrend(currProfileViews, prevProfileViews), isPositive: currProfileViews >= prevProfileViews },
        searchAppearances: { value: currSearchApps, trend: calculateTrend(currSearchApps, prevSearchApps), isPositive: currSearchApps >= prevSearchApps },
        connectionRequests: { value: currConnReqs, trend: calculateTrend(currConnReqs, prevConnReqs), isPositive: currConnReqs >= prevConnReqs },
        followerGrowth: { value: currFollowers, trend: calculateTrend(currFollowers, prevFollowers), isPositive: currFollowers >= prevFollowers },
        opportunityViews: { value: currOppViews, trend: calculateTrend(currOppViews, prevOppViews), isPositive: previousStart ? currOppViews >= prevOppViews : null },
        resumeViews: { value: currResumeViews, trend: calculateTrend(currResumeViews, prevResumeViews), isPositive: previousStart ? currResumeViews >= prevResumeViews : null },
        resumeDownloads: { value: currResumeDownloads, trend: calculateTrend(currResumeDownloads, prevResumeDownloads), isPositive: previousStart ? currResumeDownloads >= prevResumeDownloads : null },
    };

    // Fix null isPositive for stable cases if wanted, or leave to frontend logic

    // 5. Chart Data
    const rangeDays = dateFns.differenceInDays(end, start);
    let chartLabels = [];
    let chartData = [];
    let peakDate = null;
    let maxViews = -1;

    if (rangeDays <= 31) {
        // Daily
        const allDates = generateDateRange(start, end);
        const dailyViewsRes = await pool.query(`
            SELECT DATE(date) as d, SUM(profile_views) as v 
            FROM profile_analytics_daily 
            WHERE profile_owner_id = $1 AND date >= DATE($2) AND date <= DATE($3)
            GROUP BY DATE(date)
        `, [userId, start, end]);
        
        const viewsMap = {};
        dailyViewsRes.rows.forEach(r => {
            viewsMap[dateFns.format(new Date(r.d), 'yyyy-MM-dd')] = parseInt(r.v, 10);
        });

        allDates.forEach(d => {
            const val = viewsMap[d] || 0;
            chartLabels.push(dateFns.format(new Date(d), 'dd MMM'));
            chartData.push(val);
            if (val > maxViews) {
                maxViews = val;
                peakDate = new Date(d);
            }
        });
    } else {
        // Weekly (simplified buckets logic for > 31 days)
        const weeklyRes = await pool.query(`
            SELECT DATE_TRUNC('week', date) as week_start, SUM(profile_views) as v 
            FROM profile_analytics_daily 
            WHERE profile_owner_id = $1 AND date >= DATE($2) AND date <= DATE($3)
            GROUP BY week_start ORDER BY week_start
        `, [userId, start, end]);
        
        weeklyRes.rows.forEach(r => {
            const ws = new Date(r.week_start);
            const we = dateFns.addDays(ws, 6);
            chartLabels.push(`${dateFns.format(ws, 'dd MMM')}-${dateFns.format(we, 'dd MMM')}`);
            const val = parseInt(r.v, 10);
            chartData.push(val);
            if (val > maxViews) {
                maxViews = val;
                peakDate = ws; // Just use start of week for tip check
            }
        });
    }

    // 6. Chart Tip
    let tip = null;
    if (peakDate && maxViews > 0) {
        const peakStart = peakDate;
        const peakEnd = rangeDays > 31 ? dateFns.addDays(peakDate, 6) : peakDate;
        const tipEnd = dateFns.addDays(peakEnd, 1);
        
        let recentPost = await pool.query(`
            SELECT p.post_id, p.created_at, COUNT(1) as visit_count
            FROM posts p
            JOIN profile_views pv ON p.post_id = pv.source_post_id
            WHERE p.author_id = $1 AND p.created_at < $2
              AND pv.view_date >= DATE($3) AND pv.view_date <= DATE($4)
            GROUP BY p.post_id, p.created_at
            ORDER BY visit_count DESC, p.created_at DESC
            LIMIT 1
        `, [userId, tipEnd, peakStart, peakEnd]);

        if (recentPost.rowCount === 0) {
            const fallbackStart = dateFns.subDays(peakDate, 3);
            recentPost = await pool.query(`
                SELECT post_id, created_at FROM posts 
                WHERE author_id = $1 AND created_at >= $2 AND created_at < $3
                ORDER BY created_at DESC
                LIMIT 1
            `, [userId, fallbackStart, tipEnd]);
        }

        if (recentPost.rowCount > 0) {
            const post = recentPost.rows[0];
            const dayOfWeek = dateFns.format(post.created_at, 'EEEE');
            tip = `Your activity peaked after ${dayOfWeek}'s post.`;
        }
    }

    // 7. Profile Strength
    let profileStrength = { score: 0, missingFields: [], message: "" };
    try {
        const fullProfile = await profileRepository.getProfileScoreData(userId);
        if (fullProfile) {
            const strengthResult = calculateFullProfileScore(
                fullProfile.userProfile,
                fullProfile.skills,
                fullProfile.experiences,
                fullProfile.projects,
                fullProfile.educations
            );
            profileStrength.score = strengthResult.score;
            
            // Re-map the result structure to match the frontend contract if needed
            profileStrength.missingFields = [];
            Object.entries(strengthResult.breakdown || {}).forEach(([key, val]) => {
                if (val.missing && val.missing.length > 0) {
                    profileStrength.missingFields.push(...val.missing);
                }
            });
            
            const formatFieldName = (fieldName) => {
                return fieldName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            };
            const formattedMissingFields = profileStrength.missingFields.map(formatFieldName);
            
            profileStrength.message = formattedMissingFields.length > 0 
                ? `Add ${formattedMissingFields.join(' & ')} to hit 100%`
                : "Your profile is 100% complete!";
        }
    } catch (err) {
        console.error("Profile strength error", err);
    }

    // 8. Dynamic Insights
    const insights = [];
    if (keyMetrics.profileViews.trend.includes("+")) {
        insights.push(`Profile visibility increased ${keyMetrics.profileViews.trend.replace('+', '')}`);
    }
    if (keyMetrics.opportunityViews.trend.includes("+")) {
        insights.push(`Recruiter interest increased ${keyMetrics.opportunityViews.trend.replace('+', '')}`);
    }
    
    // Insight 3: best post type
    const bestPostTypeRes = await pool.query(`
        SELECT p.post_type, SUM(pad.impressions) as total
        FROM posts p
        JOIN post_analytics_daily pad ON p.post_id = pad.post_id
        WHERE p.author_id = $1 AND pad.date >= DATE($2) AND pad.date <= DATE($3)
        GROUP BY p.post_type ORDER BY total DESC LIMIT 1
    `, [userId, start, end]);

    if (bestPostTypeRes.rowCount > 0 && bestPostTypeRes.rows[0].total > 0) {
        let typeName = bestPostTypeRes.rows[0].post_type.toLowerCase();
        if (!typeName.endsWith('s')) typeName += 's';
        insights.push(`Your ${typeName} generated the most profile visits`);
    }

    return {
        keyMetrics,
        chart: {
            labels: chartLabels,
            datasets: [{ label: "Profile Views", data: chartData }],
            startDate: dateFns.format(start, 'dd MMMM yyyy'),
            endDate: dateFns.format(end, 'dd MMMM yyyy'),
            tip
        },
        profileStrength,
        insights
    };
};

const getAudienceData = async (userId, { filter, startDate, endDate }) => {
    // 1. Get user's created_at for 'all_time' filter
    const userRes = await pool.query('SELECT created_at FROM users WHERE user_id = $1', [userId]);
    if (userRes.rowCount === 0) throw new Error("User not found");
    const userCreatedAt = userRes.rows[0].created_at;

    // 2. Resolve Dates
    const { start, end, previousStart, previousEnd } = resolveDateRange(filter, startDate, endDate, userCreatedAt);

    // 3. Viewers CTE query parts for reuse
    // UNION of unique viewer_ids from profile_views + post_impressions
    const viewersQuery = `
        SELECT viewer_id FROM profile_views 
        WHERE profile_owner_id = $1 AND view_date >= DATE($2) AND view_date <= DATE($3)
        UNION
        SELECT pi.viewer_id FROM post_impressions pi 
        JOIN posts p ON p.post_id = pi.post_id
        WHERE p.author_id = $1 AND DATE(pi.view_date) >= DATE($2) AND DATE(pi.view_date) <= DATE($3)
    `;

    // 4. Metrics queries
    // Overall reach = count of unique viewers
    const currReachRes = await pool.query(`SELECT COUNT(1) as count FROM (${viewersQuery}) v`, [userId, start, end]);
    const currReach = parseInt(currReachRes.rows[0].count, 10);
    
    // Profile views from daily analytics
    const currProfileViewsRes = await pool.query(`
        SELECT COALESCE(SUM(profile_views), 0) as count 
        FROM profile_analytics_daily 
        WHERE profile_owner_id = $1 AND date >= DATE($2) AND date <= DATE($3)
    `, [userId, start, end]);
    const currProfileViews = parseInt(currProfileViewsRes.rows[0].count, 10);

    // Engagement Rate
    const currEngagementRes = await pool.query(`
        SELECT 
            COALESCE(SUM(impressions), 0) as impressions,
            COALESCE(SUM(likes + comments + shares + saves), 0) as engagements
        FROM post_analytics_daily pad
        JOIN posts p ON p.post_id = pad.post_id
        WHERE p.author_id = $1 AND pad.date >= DATE($2) AND pad.date <= DATE($3)
    `, [userId, start, end]);
    
    let currEngagementRate = 0;
    const currImpressions = parseInt(currEngagementRes.rows[0].impressions, 10);
    const currEngagements = parseInt(currEngagementRes.rows[0].engagements, 10);
    if (currImpressions > 0) {
        currEngagementRate = (currEngagements / currImpressions) * 100;
    }

    // Previous Period Metrics
    let prevReach = 0, prevProfileViews = 0, prevEngagementRate = 0;
    if (previousStart && previousEnd) {
        const prevReachRes = await pool.query(`SELECT COUNT(1) as count FROM (${viewersQuery}) v`, [userId, previousStart, previousEnd]);
        prevReach = parseInt(prevReachRes.rows[0].count, 10);

        const prevProfileViewsRes = await pool.query(`
            SELECT COALESCE(SUM(profile_views), 0) as count 
            FROM profile_analytics_daily 
            WHERE profile_owner_id = $1 AND date >= DATE($2) AND date <= DATE($3)
        `, [userId, previousStart, previousEnd]);
        prevProfileViews = parseInt(prevProfileViewsRes.rows[0].count, 10);

        const prevEngagementRes = await pool.query(`
            SELECT 
                COALESCE(SUM(impressions), 0) as impressions,
                COALESCE(SUM(likes + comments + shares + saves), 0) as engagements
            FROM post_analytics_daily pad
            JOIN posts p ON p.post_id = pad.post_id
            WHERE p.author_id = $1 AND pad.date >= DATE($2) AND pad.date <= DATE($3)
        `, [userId, previousStart, previousEnd]);
        
        const prevImpressions = parseInt(prevEngagementRes.rows[0].impressions, 10);
        const prevEngagements = parseInt(prevEngagementRes.rows[0].engagements, 10);
        if (prevImpressions > 0) {
            prevEngagementRate = (prevEngagements / prevImpressions) * 100;
        }
    }

    const topMetrics = {
        overallReach: { 
            value: currReach.toLocaleString(), 
            trend: calculateTrend(currReach, prevReach), 
            isPositive: currReach >= prevReach 
        },
        profileViews: { 
            value: currProfileViews.toLocaleString(), 
            trend: calculateTrend(currProfileViews, prevProfileViews), 
            isPositive: currProfileViews >= prevProfileViews 
        },
        engagementRate: { 
            value: Number(currEngagementRate.toFixed(1)) + '%', 
            trend: calculateTrend(currEngagementRate, prevEngagementRate), 
            isPositive: currEngagementRate >= prevEngagementRate 
        }
    };

    // 5. Audience Location
    // Countries (Top 2)
    const countriesRes = await pool.query(`
        WITH viewers AS (${viewersQuery})
        SELECT u.location_country AS name, COUNT(1) AS cnt
        FROM viewers v 
        JOIN users u ON u.user_id = v.viewer_id
        WHERE u.location_country IS NOT NULL AND u.location_country != ''
        GROUP BY u.location_country 
        ORDER BY cnt DESC 
        LIMIT 2
    `, [userId, start, end]);

    // Cities (Top 4)
    const citiesRes = await pool.query(`
        WITH viewers AS (${viewersQuery})
        SELECT u.location_city AS name, COUNT(1) AS cnt
        FROM viewers v 
        JOIN users u ON u.user_id = v.viewer_id
        WHERE u.location_city IS NOT NULL AND u.location_city != ''
        GROUP BY u.location_city 
        ORDER BY cnt DESC 
        LIMIT 4
    `, [userId, start, end]);

    const totalViewers = currReach > 0 ? currReach : 1; // Prevent division by zero

    const countries = countriesRes.rows.map(r => ({
        name: r.name,
        value: Number(((parseInt(r.cnt, 10) / totalViewers) * 100).toFixed(1))
    }));

    const cities = citiesRes.rows.map(r => ({
        name: r.name,
        value: Number(((parseInt(r.cnt, 10) / totalViewers) * 100).toFixed(1))
    }));

    // 6. Audience Industries (Top 5, including 'Other')
    const industriesRes = await pool.query(`
        WITH viewers AS (${viewersQuery})
        SELECT
            COALESCE(NULLIF(p.working_industry, ''), 'Other') AS name,
            COUNT(1) AS cnt
        FROM viewers v 
        JOIN users u ON u.user_id = v.viewer_id
        LEFT JOIN profiles p ON p.user_id = u.user_id
        GROUP BY 1
        ORDER BY cnt DESC 
        LIMIT 5
    `, [userId, start, end]);

    const audienceIndustries = industriesRes.rows.map(r => ({
        name: formatIndustryName(r.name),
        value: Number(((parseInt(r.cnt, 10) / totalViewers) * 100).toFixed(1))
    }));

    // 7. Dynamic Insights
    const insights = [];
    
    // Insight 1: Demographics
    if (cities.length > 0 && audienceIndustries.length > 0) {
        const topCity = cities[0].name;
        // Find the top industry that isn't "Other", or fallback to the top one
        let topIndustry = audienceIndustries[0].name;
        const nonOther = audienceIndustries.find(i => i.name !== 'Other');
        if (nonOther) topIndustry = nonOther.name;
        
        insights.push(`Your profile is most popular among ${topIndustry} professionals in ${topCity}`);
    }

    // Insight 2: Location
    if (countries.length > 0) {
        const topCountry = countries[0];
        if (topCountry.value > 50) {
            insights.push(`${topCountry.name} accounts for ${topCountry.value}% of your audience`);
        } else {
            insights.push(`Majority of your audience is based in ${topCountry.name}`);
        }
    }

    // Insight 3: Engagement
    const engTrendStr = topMetrics.engagementRate.trend;
    if (engTrendStr === "Stable") {
        insights.push("Your engagement rate remained stable this period");
    } else {
        const direction = engTrendStr.startsWith('+') ? "increased" : "decreased";
        const val = engTrendStr.replace('+', '').replace('-', '');
        insights.push(`Your engagement ${direction} by ${val} this period`);
    }

    return {
        topMetrics,
        audienceLocation: {
            countries,
            cities
        },
        audienceIndustries,
        insights
    };
};

const getOpportunitiesData = async (userId, { filter, startDate, endDate }) => {
    // 1. Resolve Dates
    const userRes = await pool.query('SELECT created_at FROM users WHERE user_id = $1', [userId]);
    if (userRes.rowCount === 0) throw new Error("User not found");
    const userCreatedAt = userRes.rows[0].created_at;
    const { start, end, previousStart, previousEnd } = resolveDateRange(filter, startDate, endDate, userCreatedAt);

    // Helper function for metric queries
    const getCount = async (query, params) => {
        const res = await pool.query(query, params);
        return parseInt(res.rows[0].count, 10);
    };

    // 2. Opportunity Activity (Dashboard Views + Offers)
    const getOppActivity = async (s, e) => {
        const oppOffersQuery = `
            SELECT COUNT(1) as count 
            FROM job_offers jo
            WHERE jo.user_id = $1 
              AND jo.created_at >= $2 
              AND jo.created_at <= $3
              AND NOT EXISTS (
                  SELECT 1 FROM profile_views pv 
                  WHERE pv.profile_owner_id = jo.user_id 
                    AND pv.viewer_id = jo.sent_by 
                    AND pv.source = 'job_application_dashboard'
                    AND pv.view_date = DATE(jo.created_at)
              )
        `;
        const pvCount = await getCount(`SELECT COUNT(1) as count FROM profile_views WHERE profile_owner_id = $1 AND source = 'job_application_dashboard' AND view_date >= DATE($2) AND view_date <= DATE($3)`, [userId, s, e]);
        const offersCount = await getCount(oppOffersQuery, [userId, s, e]);
        return pvCount + offersCount;
    };

    const currActivity = await getOppActivity(start, end);
    let prevActivity = 0;
    if (previousStart && previousEnd) {
        prevActivity = await getOppActivity(previousStart, previousEnd);
    }

    // 3. Repeat Visitors
    const getRepeatVisitors = async (s, e) => {
        const res = await pool.query(`
            SELECT viewer_id, COUNT(1) as visits
            FROM profile_views 
            WHERE profile_owner_id = $1 
              AND (source = 'job_application_dashboard' OR viewer_company_org_id IS NOT NULL)
              AND view_date >= DATE($2) AND view_date <= DATE($3)
              AND viewer_id IS NOT NULL
            GROUP BY viewer_id
        `, [userId, s, e]);
        
        const orgRes = await pool.query(`
            SELECT organization_id, COUNT(1) as visits
            FROM organization_profile_views 
            WHERE profile_owner_id = $1 
              AND viewed_at >= $2 AND viewed_at <= $3
            GROUP BY organization_id
        `, [userId, s, e]);
        
        const totalUnique = res.rowCount + orgRes.rowCount;
        const repeatCount = res.rows.filter(r => parseInt(r.visits, 10) > 1).length + orgRes.rows.filter(r => parseInt(r.visits, 10) > 1).length;
        const percentage = totalUnique > 0 ? (repeatCount / totalUnique) * 100 : 0;
        
        return { count: repeatCount, percentage: Number(percentage.toFixed(1)) };
    };

    const currRepeat = await getRepeatVisitors(start, end);
    let prevRepeat = { percentage: 0 };
    if (previousStart && previousEnd) {
        prevRepeat = await getRepeatVisitors(previousStart, previousEnd);
    }

    const topMetrics = {
        opportunityActivity: {
            value: currActivity.toLocaleString(),
            trend: calculateTrend(currActivity, prevActivity),
            isPositive: previousStart ? currActivity >= prevActivity : null,
            label: "recruiter views & offers"
        },
        repeatVisitors: {
            percentage: currRepeat.percentage + "%",
            count: currRepeat.count,
            label: "recruiters returned to your profile multiple times."
        }
    };

    // 4. Top Organizations
    const topOrgsRes = await pool.query(`
        WITH combined_views AS (
            SELECT viewer_company_org_id as org_id, viewer_id, view_date::timestamp as v_date
            FROM profile_views
            WHERE profile_owner_id = $1 AND view_date >= DATE($2) AND view_date <= DATE($3)
              AND viewer_company_org_id IS NOT NULL
            UNION ALL
            SELECT organization_id as org_id, NULL as viewer_id, viewed_at as v_date
            FROM organization_profile_views
            WHERE profile_owner_id = $1 AND viewed_at >= $2 AND viewed_at <= $3
        )
        SELECT 
            org.name, COALESCE(NULLIF(org.industry, ''), 'Other') as industry, org.logo_url as icon,
            COUNT(1) as visits_count,
            MAX(u.headline) as role
        FROM combined_views cv
        JOIN organizations org ON cv.org_id = org.org_id
        LEFT JOIN users u ON cv.viewer_id = u.user_id
        GROUP BY cv.org_id, org.name, org.industry, org.logo_url
        ORDER BY MAX(cv.v_date) DESC, visits_count DESC
        LIMIT 50
    `, [userId, start, end]);

    const topOrganizations = topOrgsRes.rows.map(r => ({
        name: r.name,
        industry: formatIndustryName(r.industry),
        visits: `${r.visits_count} visits`,
        role: r.role || 'Recruiter',
        icon: r.icon || '/images/analytics/organization1.png'
    }));

    // 5. Organization Industries
    const orgIndRes = await pool.query(`
        WITH combined_views AS (
            SELECT viewer_company_org_id as org_id
            FROM profile_views
            WHERE profile_owner_id = $1 AND view_date >= DATE($2) AND view_date <= DATE($3)
              AND viewer_company_org_id IS NOT NULL
            UNION ALL
            SELECT organization_id as org_id
            FROM organization_profile_views
            WHERE profile_owner_id = $1 AND viewed_at >= $2 AND viewed_at <= $3
        )
        SELECT 
            COALESCE(NULLIF(org.industry, ''), 'Other') as name,
            COUNT(1) as visits_count
        FROM combined_views cv
        JOIN organizations org ON cv.org_id = org.org_id
        GROUP BY 1
        ORDER BY visits_count DESC
        LIMIT 4
    `, [userId, start, end]);

    let totalOrgVisits = 0;
    orgIndRes.rows.forEach(r => { totalOrgVisits += parseInt(r.visits_count, 10); });
    
    const organizationIndustries = orgIndRes.rows.map(r => ({
        name: formatIndustryName(r.name),
        value: Number(((parseInt(r.visits_count, 10) / (totalOrgVisits || 1)) * 100).toFixed(1))
    }));

    // 6. Dynamic Insights
    const insights = [];
    
    // Insight 1
    if (organizationIndustries.length > 0) {
        insights.push(`Recruiters from ${organizationIndustries[0].name} companies showed the highest interest this period`);
    }
    
    // Insight 2
    if (topOrganizations.length > 0) {
        insights.push(`${topOrganizations[0].role} roles generated the most profile visits`);
    }
    
    // Insight 3
    if (previousStart) {
        const diff = currRepeat.percentage - prevRepeat.percentage;
        const trendVerb = diff >= 0 ? 'more' : 'less';
        insights.push(`Recruiters revisited your profile ${Math.abs(diff).toFixed(1)}% ${trendVerb} often than last period`);
    }

    return {
        topMetrics,
        topOrganizations,
        organizationIndustries,
        insights
    };
};

const getContentData = async (userId, { filter, startDate, endDate, sort }) => {
    // 1. Resolve Dates
    const userRes = await pool.query('SELECT created_at FROM users WHERE user_id = $1', [userId]);
    if (userRes.rowCount === 0) throw new Error("User not found");
    const userCreatedAt = userRes.rows[0].created_at;
    const { start, end } = resolveDateRange(filter, startDate, endDate, userCreatedAt);

    // 2. Format Performance (Aggregate views by post_type)
    const formatRes = await pool.query(`
        SELECT p.post_type, COALESCE(SUM(pad.impressions), 0) as total_views 
        FROM posts p 
        LEFT JOIN post_analytics_daily pad ON p.post_id = pad.post_id 
          AND pad.date >= DATE($2) AND pad.date <= DATE($3)
        WHERE p.author_id = $1
        GROUP BY p.post_type
    `, [userId, start, end]);

    const formatMap = { articles: 0, media: 0, polls: 0, text: 0 };
    
    formatRes.rows.forEach(r => {
        const type = (r.post_type || '').toLowerCase();
        const views = parseInt(r.total_views, 10);
        if (type.includes('article')) formatMap.articles += views;
        else if (type.includes('image') || type.includes('video') || type.includes('media')) formatMap.media += views;
        else if (type.includes('poll')) formatMap.polls += views;
        else formatMap.text += views;
    });

    const { formatNumber } = require('./analytics.helpers');

    const formatPerformance = {
        articlesViews: { value: formatNumber(formatMap.articles), icon: "solar:document-add-linear" },
        mediaViews: { value: formatNumber(formatMap.media), icon: "stash:image" },
        pollsViews: { value: formatNumber(formatMap.polls), icon: "fluent:poll-16-regular" },
        textViews: { value: formatNumber(formatMap.text), icon: "lucide:type" }
    };

    // 3. Top Performing Posts
    // Base SQL query
    let sortColumn = 'engagement_score DESC';
    if (sort === 'most_recent') sortColumn = 'p.created_at DESC';
    else if (sort === 'most_viewed') sortColumn = 'views DESC';
    else if (sort === 'most_liked') sortColumn = 'likes DESC';
    else if (sort === 'most_shared') sortColumn = 'shares DESC';

    const topPostsRes = await pool.query(`
        SELECT 
            p.post_id, p.title, p.content, p.post_type, p.created_at,
            (SELECT url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) as media_url,
            COALESCE(SUM(pad.impressions), 0) as views,
            COALESCE(SUM(pad.likes), 0) as likes,
            COALESCE(SUM(pad.shares), 0) as shares,
            (COALESCE(SUM(pad.likes), 0) + COALESCE(SUM(pad.shares), 0) + COALESCE(SUM(pad.comments), 0)) as engagement_score
        FROM posts p
        LEFT JOIN post_analytics_daily pad ON p.post_id = pad.post_id
          AND pad.date >= DATE($2) AND pad.date <= DATE($3)
        WHERE p.author_id = $1
        GROUP BY p.post_id, p.title, p.content, p.post_type, p.created_at
        ORDER BY ${sortColumn}, p.created_at DESC
    `, [userId, start, end]);

    const topPosts = topPostsRes.rows.map(p => {
        let title = p.title;
        if (!title) {
            let plainTextContent = p.content ? p.content.replace(/<[^>]*>?/gm, '').trim() : '';
            title = plainTextContent ? (plainTextContent.length > 50 ? plainTextContent.substring(0, 50) + '...' : plainTextContent) : 'No caption';
        }

        let fallbackIcon = 'lucide:type';
        const pType = (p.post_type || '').toLowerCase();
        if (pType.includes('article')) fallbackIcon = 'solar:document-add-linear';
        else if (pType.includes('poll')) fallbackIcon = 'fluent:poll-16-regular';
        else if (pType.includes('image') || pType.includes('video')) fallbackIcon = 'stash:image';

        return {
            id: p.post_id,
            title,
            type: p.post_type ? p.post_type.charAt(0).toUpperCase() + p.post_type.slice(1).toLowerCase() + ' post' : 'Post',
            date: dateFns.format(new Date(p.created_at), 'MMM dd yyyy').toLowerCase(),
            views: formatNumber(parseInt(p.views, 10)),
            likes: formatNumber(parseInt(p.likes, 10)),
            shares: formatNumber(parseInt(p.shares, 10)),
            imgSrc: p.media_url || null,
            icon: p.media_url ? null : fallbackIcon
        };
    });

    return {
        formatPerformance,
        topPosts
    };
};

const recordResumeEvent = async (viewerId, targetUserId, eventType, ipAddress, viewerOrgId = null) => {
    // Prevent self-views from counting towards analytics (optional, but good practice)
    // if (viewerId === targetUserId) {
    //     return;
    // }

    // 1. Get the target user's latest resume
    const resumeRes = await pool.query(
        'SELECT resume_id FROM user_resumes WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
        [targetUserId]
    );

    if (resumeRes.rowCount === 0) {
        throw new Error("Resume not found");
    }

    const resumeId = resumeRes.rows[0].resume_id;

    // 2. Check for duplicate event within 24 hours
    let recentEventQuery = `
        SELECT 1 FROM resume_view_events 
        WHERE resume_id = $1 AND event_type = $2 AND created_at >= NOW() - INTERVAL '24 HOURS'
    `;
    const queryParams = [resumeId, eventType];

    if (viewerId) {
        queryParams.push(viewerId);
        recentEventQuery += ` AND viewer_id = $${queryParams.length}`;
    } else if (ipAddress) {
        queryParams.push(ipAddress);
        recentEventQuery += ` AND viewer_id IS NULL AND ip_address = $${queryParams.length}`;
    } else {
        recentEventQuery = null;
    }

    if (recentEventQuery) {
        if (viewerOrgId) {
            queryParams.push(viewerOrgId);
            recentEventQuery += ` AND viewer_company_org_id = $${queryParams.length}`;
        } else {
            recentEventQuery += ` AND viewer_company_org_id IS NULL`;
        }

        const recentEventRes = await pool.query(recentEventQuery, queryParams);
        if (recentEventRes.rowCount > 0) {
            // Duplicate event within 24 hours, do not record again
            return;
        }
    }

    // 3. Insert the event
    await pool.query(
        `INSERT INTO resume_view_events (resume_id, viewer_id, event_type, ip_address, viewer_company_org_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [resumeId, viewerId || null, eventType, ipAddress || null, viewerOrgId || null]
    );
};

module.exports = {
    getOverviewData,
    getAudienceData,
    getOpportunitiesData,
    getContentData,
    recordResumeEvent
};
