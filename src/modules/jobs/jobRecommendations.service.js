'use strict';

const pool = require('../../core/db/pool');

// ─── CATEGORY CONSTANTS & METADATA ──────────────────────────────────────────

const CATEGORY_KEYS = Object.freeze({
  FEATURED: 'featured',
  BEST_MATCHES: 'best-matches',
  FROM_NETWORK: 'from-network',
  RECENTLY_VIEWED: 'recently-viewed',
});

const VALID_CATEGORIES = Object.freeze(Object.values(CATEGORY_KEYS));

const CATEGORY_METADATA = Object.freeze({
  [CATEGORY_KEYS.FEATURED]: {
    title: 'Featured opportunities',
    description: 'High-quality, complete job listings from verified employers and top recruiters.',
  },
  [CATEGORY_KEYS.BEST_MATCHES]: {
    title: 'Best matches for you',
    description: 'Opportunities ranked by how closely they match your profile skills, experience, title, and work mode.',
  },
  [CATEGORY_KEYS.FROM_NETWORK]: {
    title: 'From your network',
    description: 'Jobs posted by your connections or at companies where people in your professional network currently work.',
  },
  [CATEGORY_KEYS.RECENTLY_VIEWED]: {
    title: 'Recently viewed',
    description: 'Jobs you have previously opened and explored.',
  },
});

const MIN_MATCH_THRESHOLD = 60;

// ─── CURSOR ENCODING & DECODING ──────────────────────────────────────────────

function encodeCursor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursorString) {
  if (!cursorString || typeof cursorString !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(cursorString, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ─── FORMATTING HELPERS ──────────────────────────────────────────────────────

function getRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}

function formatSalaryDisplay(min, max, currency = 'USD', period = 'YEARLY') {
  if (!min && !max) return '';
  const symbol = currency === 'INR' ? '₹' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  const formatNum = (num) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(0)}k`;
    return num.toLocaleString();
  };

  const periodSuffix = period === 'HOURLY' ? '/hr' : period === 'MONTHLY' ? '/mo' : '/yr';

  if (min && max) {
    return `${symbol}${formatNum(min)} - ${symbol}${formatNum(max)}${periodSuffix}`;
  }
  return `${symbol}${formatNum(min || max)}${periodSuffix}`;
}

function formatExperience(row) {
  if (row.experience_min != null && row.experience_max != null) {
    return `${row.experience_min}-${row.experience_max} Yrs`;
  }
  if (row.experience_label) return row.experience_label;
  if (row.experience_level) return row.experience_level;
  if (row.experience_min != null) return `${row.experience_min}+ Yrs`;
  return '0-2 Yrs';
}

function formatJobItem(row) {
  const resolvedCompany = row.org_id
    ? (row.company_name || row.recruiter_name)
    : (row.recruiter_name || row.company_name);

  const isClosed = row.status === 'CLOSED' || row.is_active === false;
  const isAvailable = row.status !== 'CLOSED' && row.is_active !== false;
  const isSaved = Boolean(row.isSaved || row.is_saved);
  const hasApplied = Boolean(row.hasApplied || row.is_applied);
  const appStatus = row.applicationStatus || row.application_status || null;
  const applicantsCount = Number(row.applicants || row.applicants_count || 0);

  return {
    // Primary identifiers & ownership
    id: row.job_id,
    job_id: row.job_id,
    org_id: row.org_id || undefined,
    recruiter_id: row.recruiter_id || undefined,

    // Core listing content
    title: row.title,
    description: row.description || '',
    company: resolvedCompany,
    company_name: resolvedCompany,
    company_logo: row.company_logo || undefined,
    company_avatar: row.company_logo || '',
    company_slug: row.company_slug || undefined,
    recruiter_name: row.recruiter_name || undefined,
    recruiter_avatar: row.recruiter_avatar || undefined,
    location: row.location || '',
    job_type: row.job_type || 'Full time',
    work_type: row.job_type || 'Full time',
    work_mode: row.work_mode || 'Hybrid',
    industry: row.industry || '',
    tags: Array.isArray(row.tags) ? row.tags : (row.tags ? [row.tags] : []),
    skills: Array.isArray(row.skills) ? row.skills : [],

    // Compensation & formatting
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_currency: row.salary_currency || 'USD',
    salary_period: row.salary_period || 'YEARLY',
    is_salary_negotiable: Boolean(row.is_salary_negotiable),
    salary_display: formatSalaryDisplay(row.salary_min, row.salary_max, row.salary_currency, row.salary_period),

    // Experience & formatting
    experience_min: row.experience_min,
    experience_max: row.experience_max,
    experience_label: row.experience_label,
    experience_level: row.experience_level,
    experience: formatExperience(row),

    // Timestamps
    posted_at: getRelativeTime(row.published_at || row.created_at),
    published_at: row.published_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,

    // Status & Availability
    status: row.status || 'ACTIVE',
    is_active: row.is_active !== false,
    is_available: isAvailable,
    is_closed: isClosed,

    // User interaction states (both camelCase and snake_case for full frontend compatibility)
    is_saved: isSaved,
    isSaved: isSaved,
    is_applied: hasApplied,
    hasApplied: hasApplied,
    application_status: appStatus,
    applicationStatus: appStatus,

    // Offers & Applicants
    is_offer: Boolean(row.is_offer),
    offer_id: row.offer_id || null,
    offerStatus: row.offerStatus || null,
    offer_expires_at: row.offer_expires_at || null,
    applicants: applicantsCount,
    applicants_count: applicantsCount,
    saves_count: Number(row.saves_count || 0),

    // Category-specific enrichment
    quality_score: row.quality_score != null ? Math.round(Number(row.quality_score)) : undefined,
    match_score: row.match_score != null ? Math.round(Number(row.match_score)) : undefined,
    recommended_badge: row.recommended_badge || '',
    network_badge: row.network_connection_name ? {
      connection_count: row.connection_count,
      primary_name: row.network_connection_name,
      text: row.connection_count > 1 
        ? `${row.network_connection_name} and ${row.connection_count - 1} other connection${row.connection_count - 1 > 1 ? 's' : ''} work here`
        : `${row.network_connection_name} works here`
    } : null,
    last_viewed_at: row.last_viewed_at || undefined,
  };
}

// ─── COMMON ELIGIBILITY PREDICATE ───────────────────────────────────────────

/**
 * Builds the verified common eligibility SQL predicate.
 * Resolves ownership Types A, B, and C, active statuses, candidate exclusions,
 * and block checks.
 */
function buildCommonEligibilityPredicate(userId, paramIndex = 1) {
  const conditions = [
    `j.is_active = TRUE`,
    `j.status = 'ACTIVE'`,
    `(j.expires_at IS NULL OR j.expires_at > NOW())`,
    `(
      (j.org_id IS NOT NULL AND c.org_id IS NOT NULL AND (c.is_deleted IS FALSE OR c.is_deleted IS NULL) AND (c.is_deactivated IS FALSE OR c.is_deactivated IS NULL))
      OR
      (j.org_id IS NULL AND j.recruiter_id IS NOT NULL AND u.user_id IS NOT NULL AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL))
    )`,
    `(j.recruiter_id IS NULL OR u.user_id IS NULL OR (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL))`,
  ];

  const params = [];

  if (userId) {
    const userParamIdx = `$${paramIndex++}`;
    params.push(userId);

    // Candidate cannot view jobs they personally posted
    conditions.push(`(j.recruiter_id IS NULL OR j.recruiter_id != ${userParamIdx})`);

    // Universal application exclusion (Withdrawn applications remain visible)
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM job_applications ja 
      WHERE ja.job_id = j.job_id 
        AND ja.applicant_id = ${userParamIdx} 
        AND ja.current_status != 'Withdrawn'
    )`);

    // Universal offer exclusion (exclude non-withdrawn offers)
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM job_offers jo 
      WHERE jo.job_id = j.job_id 
        AND jo.user_id = ${userParamIdx}
        AND jo.status != 'withdrawn'
    )`);

    // Bi-directional block check
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (j.org_id IS NOT NULL AND ((b.blocker_id = ${userParamIdx} AND b.blocked_id = j.org_id) OR (b.blocker_id = j.org_id AND b.blocked_id = ${userParamIdx})))
         OR (j.recruiter_id IS NOT NULL AND ((b.blocker_id = ${userParamIdx} AND b.blocked_id = j.recruiter_id) OR (b.blocker_id = j.recruiter_id AND b.blocked_id = ${userParamIdx})))
    )`);
  }

  return {
    whereClause: conditions.join(' AND '),
    params,
    nextParamIndex: paramIndex,
  };
}

// ─── 1. FEATURED OPPORTUNITIES ───────────────────────────────────────────────

async function getFeaturedOpportunities(dbClient, userId, { limit = 10, cursor = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const decodedCursor = decodeCursor(cursor);

  const { whereClause, params, nextParamIndex } = buildCommonEligibilityPredicate(userId, 1);
  let paramIdx = nextParamIndex;

  let cursorFilter = '';
  if (decodedCursor && decodedCursor.score != null) {
    const pScore = `$${paramIdx++}`;
    const pSaves = `$${paramIdx++}`;
    const pDate = `$${paramIdx++}`;
    const pId = `$${paramIdx++}`;
    params.push(decodedCursor.score, decodedCursor.saves || 0, new Date(decodedCursor.created_at), decodedCursor.id);

    cursorFilter = `AND (
      quality_score < ${pScore}
      OR (quality_score = ${pScore} AND saves_count < ${pSaves})
      OR (quality_score = ${pScore} AND saves_count = ${pSaves} AND created_at < ${pDate})
      OR (quality_score = ${pScore} AND saves_count = ${pSaves} AND created_at = ${pDate} AND job_id < ${pId})
    )`;
  }

  const pLimit = `$${paramIdx++}`;
  params.push(safeLimit + 1);

  const userParam = userId ? '$1' : 'NULL';

  const query = `
    WITH scored_jobs AS (
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        u.avatar_url AS recruiter_avatar,
        COALESCE(c.name, j.company_name, u.full_name) AS company_name,
        c.logo_url AS company_logo,
        c.slug AS company_slug,
        (SELECT COUNT(*)::int FROM job_saves js_cnt WHERE js_cnt.job_id = j.job_id) AS saves_count,
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) AS applicants,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL AND ja.current_status != \'Withdrawn\') AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        (
          -- Employer Quality (40 pts max)
          (CASE 
            WHEN j.org_id IS NOT NULL THEN (
              CASE 
                WHEN c.verification_status = 'VERIFIED' THEN 25
                WHEN c.verification_status = 'DOMAIN_VERIFIED' THEN 18
                ELSE 0
              END +
              CASE WHEN c.logo_url IS NOT NULL AND c.logo_url != '' THEN 4 ELSE 0 END +
              CASE WHEN c.description IS NOT NULL AND LENGTH(c.description) > 100 THEN 4 ELSE 0 END +
              CASE WHEN c.website IS NOT NULL AND c.website != '' THEN 3 ELSE 0 END +
              CASE WHEN c.industry IS NOT NULL AND c.location IS NOT NULL THEN 4 ELSE 0 END
            )
            ELSE (
              CASE 
                WHEN u.is_identity_verified = TRUE THEN 25
                WHEN u.email IS NOT NULL THEN 18
                ELSE 0
              END +
              CASE WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' THEN 4 ELSE 0 END +
              CASE WHEN u.job_title IS NOT NULL OR u.headline IS NOT NULL THEN 4 ELSE 0 END +
              CASE WHEN u.about_text IS NOT NULL AND LENGTH(u.about_text) > 100 THEN 4 ELSE 0 END +
              CASE WHEN u.location IS NOT NULL OR u.location_city IS NOT NULL THEN 3 ELSE 0 END
            )
          END) +
          -- Listing Completeness (35 pts max)
          (
            CASE WHEN LENGTH(COALESCE(j.description, '')) > 300 THEN 10 WHEN LENGTH(COALESCE(j.description, '')) >= 150 THEN 5 ELSE 0 END +
            CASE WHEN j.salary_min IS NOT NULL AND j.salary_max IS NOT NULL THEN 10 ELSE 0 END +
            CASE WHEN j.experience_min IS NOT NULL OR j.experience_label IS NOT NULL OR j.experience_level IS NOT NULL THEN 5 ELSE 0 END +
            CASE WHEN j.work_mode IS NOT NULL AND j.location IS NOT NULL THEN 5 ELSE 0 END +
            CASE 
              WHEN (SELECT COUNT(*) FROM job_skills js_c WHERE js_c.job_id = j.job_id) >= 3 THEN 5
              WHEN (SELECT COUNT(*) FROM job_skills js_c WHERE js_c.job_id = j.job_id) >= 1 THEN 2
              ELSE 0
            END
          ) +
          -- Job Freshness (25 pts max)
          (
            CASE 
              WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '24 HOURS' THEN 25
              WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '3 DAYS' THEN 20
              WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '7 DAYS' THEN 15
              WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '14 DAYS' THEN 10
              ELSE 5
            END
          )
        ) AS quality_score
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? `LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = ${userParam}` : ''}
      ${userId ? `LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = ${userParam}` : ''}
      WHERE ${whereClause}
    )
    SELECT * FROM scored_jobs
    WHERE 1=1 ${cursorFilter}
    ORDER BY quality_score DESC, saves_count DESC, COALESCE(published_at, created_at) DESC, job_id DESC
    LIMIT ${pLimit};
  `;

  const result = await dbClient.query(query, params);
  const rows = result.rows;

  const hasMore = rows.length > safeLimit;
  const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(formatJobItem);

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    const lastRow = rows[items.length - 1];
    nextCursor = encodeCursor({
      score: lastItem.quality_score,
      saves: lastRow.saves_count || lastItem.saves_count || 0,
      created_at: lastItem.created_at,
      id: lastItem.id,
    });
  }

  return { items, nextCursor, hasMore };
}

// ─── 2. BEST MATCHES FOR YOU ────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'and', 'the', 'in', 'of', 'to',
  'for', 'a', 'an', 'at', 'by', 'with', 'engineer', 'developer', 'specialist', 'manager'
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function calculateTitleSimilarity(candidateTitle, jobTitle) {
  if (!candidateTitle || !candidateTitle.trim()) return 35;
  const normC = candidateTitle.toLowerCase().trim();
  const normJ = (jobTitle || '').toLowerCase().trim();
  if (normC === normJ || normJ.includes(normC) || normC.includes(normJ)) return 100;

  const tokensC = new Set(tokenize(candidateTitle));
  const tokensJ = new Set(tokenize(jobTitle));
  if (tokensC.size === 0 || tokensJ.size === 0) return 35;

  let intersection = 0;
  for (const t of tokensC) {
    if (tokensJ.has(t)) intersection++;
  }
  const union = new Set([...tokensC, ...tokensJ]).size;
  return union > 0 ? Math.round((intersection / union) * 100) : 35;
}

function calculateMergedExperienceYears(experiences) {
  if (!Array.isArray(experiences) || experiences.length === 0) return 0;

  const intervals = experiences
    .map(exp => {
      if (!exp.start_date) return null;
      const start = new Date(exp.start_date).getTime();
      const end = exp.is_current || !exp.end_date ? Date.now() : new Date(exp.end_date).getTime();
      if (isNaN(start) || isNaN(end) || end < start) return null;
      return { start, end };
    })
    .filter(Boolean);

  if (intervals.length === 0) return 0;

  intervals.sort((a, b) => a.start - b.start);

  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const current = intervals[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  const totalMs = merged.reduce((sum, int) => sum + (int.end - int.start), 0);
  const years = totalMs / (1000 * 60 * 60 * 24 * 365.25);
  return Math.round(years * 10) / 10;
}

function calculateExpScore(candidateYears, expMin, expMax) {
  const yMin = expMin != null ? expMin : 0;
  const yMax = expMax != null ? expMax : Infinity;

  if (expMin == null && expMax == null) return 70;

  if (candidateYears === 0) {
    return yMin <= 1 ? 65 : 30;
  }

  if (candidateYears >= yMin && candidateYears <= yMax) {
    return 100;
  }

  if (candidateYears > yMax) {
    return candidateYears <= yMax + 2 ? 85 : 65;
  }

  return (yMin - candidateYears) <= 1 ? 40 : 20;
}

function calculateLocModeScore(workPref, candLocation, jobMode, jobLocation) {
  let modeScore = 60;
  const jMode = (jobMode || 'Hybrid').toLowerCase();
  const cPref = (workPref || '').toLowerCase();

  if (!cPref) {
    modeScore = jMode === 'remote' ? 80 : 60;
  } else if (cPref === 'remote') {
    modeScore = jMode === 'remote' ? 100 : jMode === 'hybrid' ? 50 : 20;
  } else if (cPref === 'onsite') {
    modeScore = jMode === 'onsite' ? 100 : jMode === 'hybrid' ? 70 : 40;
  } else if (cPref === 'hybrid') {
    modeScore = jMode === 'hybrid' ? 100 : jMode === 'onsite' ? 70 : 60;
  }

  let locScore = 50;
  if (jMode === 'remote') {
    locScore = 100;
  } else if (!candLocation) {
    locScore = 50;
  } else {
    const cLoc = candLocation.toLowerCase().trim();
    const jLoc = (jobLocation || '').toLowerCase().trim();
    if (jLoc && (jLoc.includes(cLoc) || cLoc.includes(jLoc))) {
      locScore = 100;
    } else {
      locScore = 20;
    }
  }

  return Math.round(0.5 * modeScore + 0.5 * locScore);
}

function calculateSalaryScore(candMin, candMax, jobMin, jobMax, jobPeriod) {
  if (candMin == null && candMax == null) return 50;
  if (jobMin == null && jobMax == null) return 50;

  const cMin = candMin || candMax || 0;
  const cMax = candMax || candMin || Infinity;

  const multiplier = jobPeriod === 'HOURLY' ? 2080 : jobPeriod === 'MONTHLY' ? 12 : 1;
  const jMin = (jobMin || jobMax || 0) * multiplier;
  const jMax = (jobMax || jobMin || Infinity) * multiplier;

  if (jMax >= cMin && jMin <= cMax) return 100;

  const lowerBoundary = cMin * 0.8;
  const upperBoundary = cMax * 1.2;
  if (jMax >= lowerBoundary && jMin <= upperBoundary) return 70;

  return 30;
}

function calculateSkillsScore(candidateSkills, jobSkills) {
  if (!jobSkills || jobSkills.length === 0) return 50;
  if (!candidateSkills || candidateSkills.length === 0) return 20;

  const cSet = new Set(candidateSkills.map(s => s.toLowerCase().trim()));
  let matchCount = 0;
  for (const js of jobSkills) {
    if (cSet.has(js.toLowerCase().trim())) {
      matchCount++;
    }
  }
  return Math.round((matchCount / jobSkills.length) * 100);
}

function calculateCompositeMatchScore(candidate, job) {
  const sSkills = calculateSkillsScore(candidate.candidateSkills, job.skills);
  const sTitle = calculateTitleSimilarity(candidate.candidateTitle, job.title);
  const sExp = calculateExpScore(candidate.candidateYears, job.experience_min, job.experience_max);
  const sLocMode = calculateLocModeScore(candidate.workPreference, candidate.location, job.work_mode, job.location);
  const sSalary = calculateSalaryScore(candidate.minSalary, candidate.maxSalary, job.salary_min, job.salary_max, job.salary_period);

  return Math.round(
    0.35 * sSkills +
    0.25 * sTitle +
    0.15 * sExp +
    0.15 * sLocMode +
    0.10 * sSalary
  );
}

async function getBestMatches(dbClient, userId, { limit = 10, cursor = null } = {}) {
  if (!userId) {
    return { items: [], nextCursor: null, hasMore: false, requiresAuth: true };
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const decodedCursor = decodeCursor(cursor);

  // 1. Fetch Candidate Profile Signals
  const [profileRes, skillsRes, expRes] = await Promise.all([
    dbClient.query(
      `SELECT u.job_title, u.headline, u.location, u.location_city, u.location_country, p.work_preference
       FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id = $1 LIMIT 1`,
      [userId]
    ),
    dbClient.query(
      `SELECT DISTINCT LOWER(TRIM(s.name)) as skill_name 
       FROM profiles p JOIN user_skills us ON us.profile_id = p.profile_id JOIN skills s ON s.skill_id = us.skill_id 
       WHERE p.user_id = $1`,
      [userId]
    ),
    dbClient.query(
      `SELECT e.title, e.start_date, e.end_date, e.is_current 
       FROM profiles p JOIN experiences e ON e.profile_id = p.profile_id 
       WHERE p.user_id = $1 ORDER BY e.start_date ASC`,
      [userId]
    ),
  ]);

  const profile = profileRes.rows[0] || {};
  const candidateSkills = skillsRes.rows.map(r => r.skill_name);
  const candidateYears = calculateMergedExperienceYears(expRes.rows);

  let candidateTitle = profile.job_title || profile.headline || '';
  if (!candidateTitle && expRes.rows.length > 0) {
    const cur = expRes.rows.find(e => e.is_current) || expRes.rows[expRes.rows.length - 1];
    candidateTitle = cur?.title || '';
  }

  const candidate = {
    candidateTitle,
    candidateSkills,
    candidateYears,
    workPreference: profile.work_preference || null,
    location: profile.location || profile.location_city || profile.location_country || null,
    minSalary: null,
    maxSalary: null,
  };

  // 2. Fetch candidate eligible jobs
  const { whereClause, params } = buildCommonEligibilityPredicate(userId, 1);

  const query = `
    SELECT 
      j.*,
      u.full_name AS recruiter_name,
      u.avatar_url AS recruiter_avatar,
      COALESCE(c.name, j.company_name, u.full_name) AS company_name,
      c.logo_url AS company_logo,
      c.slug AS company_slug,
      (SELECT ARRAY_AGG(LOWER(TRIM(s.name))) FROM job_skills js JOIN skills s ON js.skill_id = s.skill_id WHERE js.job_id = j.job_id) AS skills,
      (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) AS applicants,
      (js.user_id IS NOT NULL) AS "isSaved",
      (ja.application_id IS NOT NULL AND ja.current_status != 'Withdrawn') AS "hasApplied",
      ja.current_status AS "applicationStatus"
    FROM jobs j
    LEFT JOIN active_users u ON j.recruiter_id = u.user_id
    LEFT JOIN organizations c ON j.org_id = c.org_id
    LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1
    LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1
    WHERE ${whereClause}
    ORDER BY j.created_at DESC
    LIMIT 200;
  `;

  const result = await dbClient.query(query, params);
  const scoredJobs = [];

  for (const row of result.rows) {
    const matchScore = calculateCompositeMatchScore(candidate, row);
    if (matchScore >= MIN_MATCH_THRESHOLD) {
      row.match_score = matchScore;
      scoredJobs.push(row);
    }
  }

  // Sort descending by match score, then created_at DESC, job_id DESC
  scoredJobs.sort((a, b) => {
    if (b.match_score !== a.match_score) return b.match_score - a.match_score;
    const diffTime = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (diffTime !== 0) return diffTime;
    return b.job_id.localeCompare(a.job_id);
  });

  // Keyset cursor evaluation
  let filtered = scoredJobs;
  if (decodedCursor && decodedCursor.score != null) {
    const cTime = new Date(decodedCursor.created_at).getTime();
    filtered = scoredJobs.filter(j => {
      if (j.match_score < decodedCursor.score) return true;
      if (j.match_score === decodedCursor.score) {
        const jTime = new Date(j.created_at).getTime();
        if (jTime < cTime) return true;
        if (jTime === cTime && j.job_id.localeCompare(decodedCursor.id) < 0) return true;
      }
      return false;
    });
  }

  const hasMore = filtered.length > safeLimit;
  const items = (hasMore ? filtered.slice(0, safeLimit) : filtered).map(formatJobItem);

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCursor({
      score: lastItem.match_score,
      created_at: lastItem.created_at,
      id: lastItem.id,
    });
  }

  return { items, nextCursor, hasMore };
}

// ─── 3. FROM YOUR NETWORK ───────────────────────────────────────────────────

async function getFromNetwork(dbClient, userId, { limit = 10, cursor = null } = {}) {
  if (!userId) {
    return { items: [], nextCursor: null, hasMore: false, requiresAuth: true };
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const decodedCursor = decodeCursor(cursor);

  const { whereClause, params, nextParamIndex } = buildCommonEligibilityPredicate(userId, 1);
  let paramIdx = nextParamIndex;

  let cursorFilter = '';
  if (decodedCursor && (decodedCursor.f_tier != null || decodedCursor.freshness_tier != null)) {
    const pFTier = `$${paramIdx++}`;
    const pDTier = `$${paramIdx++}`;
    const pCount = `$${paramIdx++}`;
    const pDate = `$${paramIdx++}`;
    const pId = `$${paramIdx++}`;
    params.push(
      decodedCursor.f_tier ?? decodedCursor.freshness_tier ?? 1,
      decodedCursor.d_tier ?? decodedCursor.direct_recruiter_tier ?? 1,
      decodedCursor.count ?? 1,
      new Date(decodedCursor.created_at),
      decodedCursor.id
    );

    cursorFilter = `AND (
      freshness_tier > ${pFTier}
      OR (freshness_tier = ${pFTier} AND direct_recruiter_tier > ${pDTier})
      OR (freshness_tier = ${pFTier} AND direct_recruiter_tier = ${pDTier} AND connection_count < ${pCount})
      OR (freshness_tier = ${pFTier} AND direct_recruiter_tier = ${pDTier} AND connection_count = ${pCount} AND created_at < ${pDate})
      OR (freshness_tier = ${pFTier} AND direct_recruiter_tier = ${pDTier} AND connection_count = ${pCount} AND created_at = ${pDate} AND job_id < ${pId})
    )`;
  } else if (decodedCursor && decodedCursor.count != null) {
    const pCount = `$${paramIdx++}`;
    const pDate = `$${paramIdx++}`;
    const pId = `$${paramIdx++}`;
    params.push(
      decodedCursor.count,
      new Date(decodedCursor.created_at),
      decodedCursor.id
    );

    cursorFilter = `AND (
      connection_count < ${pCount}
      OR (connection_count = ${pCount} AND created_at < ${pDate})
      OR (connection_count = ${pCount} AND created_at = ${pDate} AND job_id < ${pId})
    )`;
  }

  const pLimit = `$${paramIdx++}`;
  params.push(safeLimit + 1);

  const query = `
    WITH direct_connections AS (
      SELECT connected_user_id AS connection_id FROM connections WHERE user_id = $1
      UNION
      SELECT user_id AS connection_id FROM connections WHERE connected_user_id = $1
    ),
    connection_employers AS (
      SELECT DISTINCT ON (dc.connection_id, affiliation.org_id)
        dc.connection_id,
        affiliation.org_id,
        affiliation.priority_tier,
        affiliation.affiliation_date,
        affiliation.title
      FROM direct_connections dc
      CROSS JOIN LATERAL (
        -- Tier 1: Official organization member
        SELECT 
          om.org_id, 
          1 AS priority_tier, 
          om.joined_at AS affiliation_date, 
          NULL::text AS title
        FROM organization_members om
        WHERE om.user_id = dc.connection_id 
          AND om.status = 'ACTIVE' 
          AND om.org_id IS NOT NULL
        
        UNION ALL
        
        -- Tier 2: Self-reported current experience
        SELECT 
          e.org_id, 
          2 AS priority_tier, 
          e.start_date::timestamptz AS affiliation_date, 
          e.title
        FROM profiles p
        JOIN experiences e ON e.profile_id = p.profile_id 
          AND e.is_current = TRUE 
          AND e.org_id IS NOT NULL
        WHERE p.user_id = dc.connection_id
      ) affiliation
      ORDER BY 
        dc.connection_id, 
        affiliation.org_id, 
        affiliation.priority_tier ASC, 
        affiliation.affiliation_date ASC NULLS LAST
    ),
    org_connection_summary AS (
      SELECT 
        ce.org_id,
        COUNT(DISTINCT ce.connection_id)::int AS connection_count,
        (
          SELECT u.full_name
          FROM connection_employers ce_inner
          JOIN users u ON u.user_id = ce_inner.connection_id
          WHERE ce_inner.org_id = ce.org_id
          ORDER BY ce_inner.priority_tier ASC, ce_inner.affiliation_date ASC NULLS LAST, u.full_name ASC
          LIMIT 1
        ) AS primary_connection_name,
        MIN(ce.priority_tier) AS primary_tier,
        MIN(ce.affiliation_date) AS earliest_affiliation_date
      FROM connection_employers ce
      GROUP BY ce.org_id
    ),
    network_jobs AS (
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        u.avatar_url AS recruiter_avatar,
        COALESCE(c.name, j.company_name, u.full_name) AS company_name,
        c.logo_url AS company_logo,
        c.slug AS company_slug,
        COALESCE(ocs.connection_count, 1) AS connection_count,
        COALESCE(ocs.primary_connection_name, u.full_name) AS network_connection_name,
        COALESCE(ocs.primary_tier, 1) AS primary_tier,
        COALESCE(ocs.earliest_affiliation_date, j.created_at) AS affiliation_date,
        (CASE 
          WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '14 DAYS' THEN 1 
          WHEN COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL '30 DAYS' THEN 2 
          ELSE 3 
        END) AS freshness_tier,
        (CASE WHEN dc_recruiter.connection_id IS NOT NULL THEN 1 ELSE 2 END) AS direct_recruiter_tier,
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) AS applicants,
        (js.user_id IS NOT NULL) AS "isSaved",
        (ja.application_id IS NOT NULL AND ja.current_status != 'Withdrawn') AS "hasApplied",
        ja.current_status AS "applicationStatus"
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      LEFT JOIN org_connection_summary ocs ON j.org_id = ocs.org_id
      LEFT JOIN direct_connections dc_recruiter ON j.recruiter_id = dc_recruiter.connection_id
      LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1
      LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1
      WHERE ${whereClause}
        AND (ocs.org_id IS NOT NULL OR dc_recruiter.connection_id IS NOT NULL)
    )
    SELECT * FROM network_jobs
    WHERE 1=1 ${cursorFilter}
    ORDER BY freshness_tier ASC, direct_recruiter_tier ASC, connection_count DESC, COALESCE(published_at, created_at) DESC, job_id DESC
    LIMIT ${pLimit};
  `;

  const result = await dbClient.query(query, params);
  const rows = result.rows;

  const hasMore = rows.length > safeLimit;
  const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(formatJobItem);

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCursor({
      f_tier: rows[items.length - 1].freshness_tier,
      d_tier: rows[items.length - 1].direct_recruiter_tier,
      count: lastItem.network_badge?.connection_count || 1,
      created_at: lastItem.created_at,
      id: lastItem.id,
    });
  }

  return { items, nextCursor, hasMore };
}

// ─── 4. RECENTLY VIEWED ─────────────────────────────────────────────────────

async function getRecentlyViewed(dbClient, userId, { limit = 10, cursor = null } = {}) {
  if (!userId) {
    return { items: [], nextCursor: null, hasMore: false, requiresAuth: true };
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
  const decodedCursor = decodeCursor(cursor);

  const { whereClause, params, nextParamIndex } = buildCommonEligibilityPredicate(userId, 1);
  let paramIdx = nextParamIndex;

  let cursorFilter = '';
  if (decodedCursor && decodedCursor.last_viewed_at) {
    const pDate = `$${paramIdx++}`;
    const pId = `$${paramIdx++}`;
    params.push(new Date(decodedCursor.last_viewed_at), decodedCursor.id);

    cursorFilter = `AND (
      latest_views.last_viewed_at < ${pDate}
      OR (latest_views.last_viewed_at = ${pDate} AND j.job_id < ${pId})
    )`;
  }

  const pLimit = `$${paramIdx++}`;
  params.push(safeLimit + 1);

  const query = `
    SELECT 
      j.*,
      u.full_name AS recruiter_name,
      u.avatar_url AS recruiter_avatar,
      COALESCE(c.name, j.company_name, u.full_name) AS company_name,
      c.logo_url AS company_logo,
      c.slug AS company_slug,
      latest_views.last_viewed_at,
      (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) AS applicants,
      (js.user_id IS NOT NULL) AS "isSaved",
      (ja.application_id IS NOT NULL AND ja.current_status != 'Withdrawn') AS "hasApplied",
      ja.current_status AS "applicationStatus"
    FROM (
      SELECT 
        entity_id AS job_id,
        MAX(created_at) AS last_viewed_at
      FROM user_activity_log
      WHERE user_id = $1
        AND action_type = 'view_job'
        AND entity_type = 'job'
        AND entity_id IS NOT NULL
      GROUP BY entity_id
    ) latest_views
    JOIN jobs j ON j.job_id = latest_views.job_id
    LEFT JOIN active_users u ON j.recruiter_id = u.user_id
    LEFT JOIN organizations c ON j.org_id = c.org_id
    LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1
    LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1
    WHERE ${whereClause}
      ${cursorFilter}
    ORDER BY latest_views.last_viewed_at DESC, j.job_id DESC
    LIMIT ${pLimit};
  `;

  const result = await dbClient.query(query, params);
  const rows = result.rows;

  const hasMore = rows.length > safeLimit;
  const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(formatJobItem);

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCursor({
      last_viewed_at: lastItem.last_viewed_at,
      id: lastItem.id,
    });
  }

  return { items, nextCursor, hasMore };
}

// ─── AGGREGATED PREVIEW SERVICE (Explore Screen) ─────────────────────────────

async function getExploreSections(userId, dbClient = null) {
  // Checks out 1 single client to execute queries sequentially without exhausting pool
  const client = dbClient || (await pool.connect());
  const shouldRelease = !dbClient;
  const PREVIEW_LIMIT = 5;
  try {
    const featured = await getFeaturedOpportunities(client, userId, { limit: PREVIEW_LIMIT });
    const bestMatches = userId ? await getBestMatches(client, userId, { limit: PREVIEW_LIMIT }) : { items: [] };
    const fromNetwork = userId ? await getFromNetwork(client, userId, { limit: PREVIEW_LIMIT }) : { items: [] };
    const recentlyViewed = userId ? await getRecentlyViewed(client, userId, { limit: PREVIEW_LIMIT }) : { items: [] };

    return {
      featured: featured.items,
      best_matches: bestMatches.items,
      from_network: fromNetwork.items,
      recently_viewed: recentlyViewed.items,
    };
  } finally {
    if (shouldRelease) client.release();
  }
}

// ─── PAGINATED CATEGORY SERVICE ("See All" Screen) ───────────────────────────

async function getCategoryPaginated(category, userId, { limit = 10, cursor = null, dbClient = null } = {}) {
  if (!VALID_CATEGORIES.includes(category)) {
    const err = new Error(`Invalid explore category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
    err.code = 'INVALID_CATEGORY';
    err.status = 400;
    throw err;
  }

  const client = dbClient || (await pool.connect());
  const shouldRelease = !dbClient;
  try {
    let result;
    switch (category) {
      case CATEGORY_KEYS.FEATURED:
        result = await getFeaturedOpportunities(client, userId, { limit, cursor });
        break;
      case CATEGORY_KEYS.BEST_MATCHES:
        result = await getBestMatches(client, userId, { limit, cursor });
        break;
      case CATEGORY_KEYS.FROM_NETWORK:
        result = await getFromNetwork(client, userId, { limit, cursor });
        break;
      case CATEGORY_KEYS.RECENTLY_VIEWED:
        result = await getRecentlyViewed(client, userId, { limit, cursor });
        break;
    }

    const meta = CATEGORY_METADATA[category];
    return {
      category,
      title: meta.title,
      description: meta.description,
      items: result.items,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      requiresAuth: Boolean(result.requiresAuth),
    };
  } finally {
    if (shouldRelease) client.release();
  }
}

module.exports = {
  formatJobItem,
  CATEGORY_KEYS,
  VALID_CATEGORIES,
  CATEGORY_METADATA,
  MIN_MATCH_THRESHOLD,
  encodeCursor,
  decodeCursor,
  buildCommonEligibilityPredicate,
  calculateMergedExperienceYears,
  calculateTitleSimilarity,
  calculateExpScore,
  calculateLocModeScore,
  calculateSalaryScore,
  calculateSkillsScore,
  calculateCompositeMatchScore,
  getFeaturedOpportunities,
  getBestMatches,
  getFromNetwork,
  getRecentlyViewed,
  getExploreSections,
  getCategoryPaginated,
};
