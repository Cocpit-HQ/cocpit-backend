/**
 * Job Search Query for COCPIT Global Search
 * Reuses buildJobFilters for multi-facet filtering (job_type, work_mode, salary, etc.)
 * with deterministic keyset cursor pagination (created_at DESC, job_id DESC)
 * and recruiter/company block filtering.
 */
const { buildJobFilters } = require('../../../core/utils/jobQueryBuilder');

function encodeJobCursor(item) {
  if (!item) return null;
  const payload = {
    t: item.created_at,
    id: item.job_id || item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeJobCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed.t && parsed.id && !isNaN(Date.parse(parsed.t))) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function searchJobs(client, { queryParams, viewerId, orgActorId, limit = 10, cursor = null }) {
  // 1. Build parameterized filters from query params
  // Base parameter: viewerId will be $1 if present
  const startParamIdx = viewerId ? 2 : 1;
  const { conditions, values, nextIndex } = buildJobFilters(queryParams, startParamIdx);

  const params = viewerId ? [viewerId, ...values] : [...values];
  let currentIdx = nextIndex;

  // Active job status & non-deleted constraints
  conditions.push(`j.is_active = TRUE`);
  conditions.push(`j.status = 'ACTIVE'`);
  conditions.push(`(j.org_id IS NOT NULL OR u.is_deactivated = FALSE)`);
  conditions.push(`(j.org_id IS NULL OR (c.is_deleted = FALSE AND c.is_deactivated = FALSE))`);

  // Block enforcement
  if (viewerId && orgActorId) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (j.org_id IS NOT NULL AND (
        (b.blocker_id = $1 AND b.blocked_id = j.org_id) OR (b.blocker_id = j.org_id AND b.blocked_id = $1) OR
        (b.blocker_id = $${currentIdx} AND b.blocked_id = j.org_id) OR (b.blocker_id = j.org_id AND b.blocked_id = $${currentIdx})
      ))
         OR (j.recruiter_id IS NOT NULL AND (
        (b.blocker_id = $1 AND b.blocked_id = j.recruiter_id) OR (b.blocker_id = j.recruiter_id AND b.blocked_id = $1) OR
        (b.blocker_id = $${currentIdx} AND b.blocked_id = j.recruiter_id) OR (b.blocker_id = j.recruiter_id AND b.blocked_id = $${currentIdx})
      ))
    )`);
    params.push(orgActorId);
    currentIdx++;
  } else if (viewerId) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (j.org_id IS NOT NULL AND ((b.blocker_id = $1 AND b.blocked_id = j.org_id) OR (b.blocker_id = j.org_id AND b.blocked_id = $1)))
         OR (j.recruiter_id IS NOT NULL AND ((b.blocker_id = $1 AND b.blocked_id = j.recruiter_id) OR (b.blocker_id = j.recruiter_id AND b.blocked_id = $1)))
    )`);
  }

  // 2. Keyset cursor pagination (created_at, job_id)
  const parsedCursor = decodeJobCursor(cursor);
  if (parsedCursor) {
    conditions.push(`(
      j.created_at < $${currentIdx} 
      OR (j.created_at = $${currentIdx} AND j.job_id < $${currentIdx + 1})
    )`);
    params.push(new Date(parsedCursor.t), parsedCursor.id);
    currentIdx += 2;
  }

  // 3. Limit (fetch limit + 1 to detect has_more)
  const fetchLimit = Number(limit) + 1;
  params.push(fetchLimit);
  const limitIdx = currentIdx;

  const savedJoin = viewerId
    ? `LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1`
    : '';
  const isSavedSelect = viewerId
    ? `(js.user_id IS NOT NULL) AS "isSaved"`
    : `FALSE AS "isSaved"`;

  const applicationsJoin = viewerId
    ? `LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1`
    : '';
  const appliedSelect = viewerId
    ? `(ja.application_id IS NOT NULL AND ja.current_status != 'Withdrawn') AS "hasApplied", ja.current_status AS "applicationStatus"`
    : `FALSE AS "hasApplied", NULL AS "applicationStatus"`;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      j.job_id,
      j.title,
      COALESCE(c.name, j.company_name, u.full_name) AS company,
      COALESCE(c.name, j.company_name, u.full_name) AS company_name,
      j.location,
      j.salary_min,
      j.salary_max,
      j.salary_currency,
      j.salary_period,
      j.job_type,
      j.work_mode,
      j.experience_min,
      j.experience_max,
      j.experience_label,
      j.industry,
      j.description,
      j.actively_hiring,
      j.easy_apply,
      j.status,
      j.is_active,
      j.created_at,
      j.org_id,
      j.recruiter_id,
      u.full_name AS recruiter_name,
      u.avatar_url AS recruiter_avatar,
      c.logo_url AS company_logo,
      COALESCE(c.logo_url, '') AS company_avatar,
      c.slug AS company_slug,
      c.verification_status,
      (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) AS applicants,
      ${isSavedSelect},
      ${appliedSelect}
    FROM jobs j
    LEFT JOIN active_users u ON j.recruiter_id = u.user_id
    LEFT JOIN organizations c ON j.org_id = c.org_id
    ${savedJoin}
    ${applicationsJoin}
    ${whereClause}
    ORDER BY j.created_at DESC, j.job_id DESC
    LIMIT $${limitIdx};
  `;

  const { rows } = await client.query(sql, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    nextCursor = encodeJobCursor(items[items.length - 1]);
  }

  const formattedItems = items.map(item => {
    let salaryDisplay = null;
    if (item.salary_min && item.salary_max) {
      salaryDisplay = `₹${Math.round(item.salary_min / 1000)}k–${Math.round(item.salary_max / 1000)}k`;
    } else if (item.salary_min) {
      salaryDisplay = `From ₹${Math.round(item.salary_min / 1000)}k`;
    }

    let cleanExp = '0-2 Yrs';
    if (item.experience_label && !item.experience_label.includes('null')) {
      cleanExp = item.experience_label;
    } else if (item.experience_min != null && item.experience_max != null) {
      cleanExp = `${item.experience_min}-${item.experience_max} Yrs`;
    } else if (item.experience_min != null) {
      cleanExp = `${item.experience_min}+ Yrs`;
    }

    return {
      id: item.job_id,
      job_id: item.job_id,
      title: item.title,
      company: item.company || item.company_name,
      company_name: item.company_name || item.company,
      company_logo: item.company_logo || null,
      company_avatar: item.company_avatar || item.company_logo || '',
      company_slug: item.company_slug,
      org_id: item.org_id || null,
      recruiter_id: item.recruiter_id || null,
      recruiter_name: item.recruiter_name || null,
      recruiter_avatar: item.recruiter_avatar || null,
      location: item.location,
      salary_min: item.salary_min,
      salary_max: item.salary_max,
      salary_currency: item.salary_currency || 'INR',
      salary_period: item.salary_period || 'year',
      salary_display: salaryDisplay,
      job_type: item.job_type,
      work_mode: item.work_mode,
      experience: cleanExp,
      experience_label: cleanExp,
      industry: item.industry,
      description: item.description || '',
      skills: Array.isArray(item.skills) ? item.skills : [],
      actively_hiring: Boolean(item.actively_hiring),
      easy_apply: Boolean(item.easy_apply),
      applicants: Number(item.applicants || 0),
      applicants_count: Number(item.applicants || 0),
      is_saved: Boolean(item.isSaved ?? item.issaved ?? item.is_saved),
      isSaved: Boolean(item.isSaved ?? item.issaved ?? item.is_saved),
      is_applied: Boolean(item.hasApplied ?? item.hasapplied ?? item.is_applied),
      hasApplied: Boolean(item.hasApplied ?? item.hasapplied ?? item.is_applied),
      application_status: item.applicationStatus || item.applicationstatus || null,
      applicationStatus: item.applicationStatus || item.applicationstatus || null,
      is_closed: item.status === 'CLOSED' || item.is_active === false,
      is_verified: item.verification_status === 'VERIFIED' || item.verification_status === 'DOMAIN_VERIFIED',
      created_at: item.created_at,
    };
  });

  return {
    items: formattedItems,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

module.exports = {
  searchJobs,
  encodeJobCursor,
  decodeJobCursor,
};

