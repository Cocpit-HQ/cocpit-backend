/**
 * Company Search Query for COCPIT Global Search
 * Queries active_organizations where entity_type = 'COMPANY' with LinkedIn-style multi-signal ranking:
 * 1. Lexical match (Exact match > Prefix match > Substring match)
 * 2. 1st-degree connections currently working here
 * 3. Viewer current/former employment here
 * 4. Viewer follow status (organization_followers)
 * 5. Company verification status
 *
 * Implements deterministic keyset cursor pagination on (relevance_score, name, org_id).
 */

/**
 * Encodes keyset cursor for company pagination
 */
function encodeCompanyCursor(item) {
  if (!item) return null;
  const payload = {
    s: typeof item.relevance_score === 'number' ? item.relevance_score : (item.sort_rank === 0 ? 100 : 20),
    n: item.name || '',
    id: item.id || item.org_id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes and validates keyset cursor for companies
 */
function decodeCompanyCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.s === 'number' &&
      typeof parsed.n === 'string' &&
      typeof parsed.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return parsed;
    }
    // Backward compatibility for legacy cursor format { r, n, id }
    if (
      typeof parsed.r === 'number' &&
      typeof parsed.n === 'string' &&
      typeof parsed.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return { s: parsed.r === 0 ? 100 : 20, n: parsed.n, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

// Known synonym and format mappings between snake_case constants and human-readable industries
const INDUSTRY_SYNONYMS = {
  information_technology: ['Information Technology', 'IT', 'Tech', 'Technology'],
  software_saas: ['Software & SaaS', 'Software and SaaS', 'Software', 'SaaS'],
  healthcare: ['Healthcare', 'Health Care', 'Medical'],
  finance_banking: ['Finance & Banking', 'Finance and Banking', 'Finance', 'Banking'],
  manufacturing: ['Manufacturing'],
};

function getIndustrySearchVariants(indStr) {
  const raw = String(indStr || '').trim();
  if (!raw) return [];
  const set = new Set([raw]);
  const lower = raw.toLowerCase();

  // 1. Underscore <-> space variants
  if (raw.includes('_')) set.add(raw.replace(/_/g, ' '));
  if (raw.includes(' ')) set.add(raw.replace(/\s+/g, '_'));

  // 2. Ampersand variants
  if (raw.includes('&')) {
    set.add(raw.replace(/&/g, 'and'));
    set.add(raw.replace(/\s*&\s*/g, ' '));
  }
  if (/\band\b/i.test(raw)) {
    set.add(raw.replace(/\band\b/gi, '&'));
  }

  // 3. Synonym mapping
  const key = lower.replace(/\s+/g, '_');
  if (INDUSTRY_SYNONYMS[key]) {
    INDUSTRY_SYNONYMS[key].forEach(syn => set.add(syn));
  }
  for (const [k, syns] of Object.entries(INDUSTRY_SYNONYMS)) {
    if (syns.some(s => s.toLowerCase() === lower)) {
      set.add(k);
      syns.forEach(syn => set.add(syn));
    }
  }

  return Array.from(set).filter(Boolean);
}

/**
 * Executes company search query with multi-signal LinkedIn ranking
 */
async function searchCompanies(client, { searchTerm, viewerId = null, orgActorId = null, limit = 10, cursor = null, queryParams = {} }) {
  const trimmed = searchTerm.trim().replace(/^['"]|['"]$/g, '');
  const likeTerm = `%${trimmed}%`;
  const prefixTerm = `${trimmed}%`;
  const parsedCursor = decodeCompanyCursor(cursor);

  // Core search parameters: $1 = likeTerm, $2 = prefixTerm, $3 = trimmed
  const params = [likeTerm, prefixTerm, trimmed];
  let viewerParamIdx = null;
  let orgActorParamIdx = null;

  if (viewerId) {
    params.push(viewerId);
    viewerParamIdx = params.length;
  } else if (orgActorId) {
    params.push(orgActorId);
    orgActorParamIdx = params.length;
  }

  // Bidirectional block filter between viewer (user or org) and target organization
  let blockFilter = '';
  if (orgActorParamIdx) {
    blockFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE ((b.blocker_id = $${orgActorParamIdx} AND b.blocked_id = c.org_id)
           OR (b.blocker_id = c.org_id AND b.blocked_id = $${orgActorParamIdx}))
      )
    `;
  } else if (viewerParamIdx) {
    blockFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE ((b.blocker_id = $${viewerParamIdx} AND b.blocked_id = c.org_id)
           OR (b.blocker_id = c.org_id AND b.blocked_id = $${viewerParamIdx}))
      )
    `;
  }

  // Optional filters: industry/type, location, and org size (supporting multi-selection)
  let industryClause = '';
  const rawInd = queryParams.industry || queryParams.org_type || queryParams.type;
  const indList = Array.isArray(rawInd)
    ? rawInd.map(s => String(s).trim()).filter(Boolean)
    : typeof rawInd === 'string' && rawInd.trim()
    ? (rawInd.includes('|') ? rawInd.split('|') : rawInd.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (indList.length > 0) {
    const indParts = [];
    for (const ind of indList) {
      const variants = getIndustrySearchVariants(ind);
      const subVariantClauses = [];
      for (const variant of variants) {
        if (!variant.trim()) continue;
        params.push(`%${variant.trim()}%`);
        const indIdx = params.length;
        subVariantClauses.push(`c.industry ILIKE $${indIdx}`);
      }
      if (subVariantClauses.length > 0) {
        indParts.push(`(${subVariantClauses.join(' OR ')})`);
      }
    }
    if (indParts.length > 0) {
      industryClause = ` AND (${indParts.join(' OR ')})`;
    }
  }

  let locationClause = '';
  const rawLoc = queryParams.location;
  const locList = Array.isArray(rawLoc)
    ? rawLoc.map(s => String(s).trim()).filter(Boolean)
    : typeof rawLoc === 'string' && rawLoc.trim()
    ? (rawLoc.includes('|') ? rawLoc.split('|') : [rawLoc]).map(s => s.trim()).filter(Boolean)
    : [];

  if (locList.length > 0) {
    const locParts = [];
    for (const loc of locList) {
      const trimmedLoc = loc.trim();
      const tokens = trimmedLoc.split(',').map(s => s.trim()).filter(Boolean);
      const primary = tokens[0] || trimmedLoc;

      params.push(`%${trimmedLoc}%`);
      const locIdx = params.length;

      params.push(`%${primary}%`);
      const primaryIdx = params.length;

      const subClauses = [
        `c.location ILIKE $${locIdx}`,
        `c.location_formatted ILIKE $${locIdx}`,
        `c.city ILIKE $${locIdx}`,
        `c.country ILIKE $${locIdx}`,
        `c.location ILIKE $${primaryIdx}`,
        `c.location_formatted ILIKE $${primaryIdx}`,
        `c.city ILIKE $${primaryIdx}`,
        `(COALESCE(c.city, '') || ', ' || COALESCE(c.country, '')) ILIKE $${locIdx}`
      ];

      // City aliases (e.g. Bangalore / Bengaluru)
      const lowerPrimary = primary.toLowerCase();
      if (lowerPrimary === 'bengaluru') {
        params.push('%Bangalore%');
        const bIdx = params.length;
        subClauses.push(`c.location ILIKE $${bIdx}`, `c.city ILIKE $${bIdx}`, `c.location_formatted ILIKE $${bIdx}`);
      } else if (lowerPrimary === 'bangalore') {
        params.push('%Bengaluru%');
        const bIdx = params.length;
        subClauses.push(`c.location ILIKE $${bIdx}`, `c.city ILIKE $${bIdx}`, `c.location_formatted ILIKE $${bIdx}`);
      }

      locParts.push(`(${subClauses.join(' OR ')})`);
    }
    locationClause = ` AND (${locParts.join(' OR ')})`;
  }

  let sizeClause = '';
  const rawSize = queryParams.org_size || queryParams.size || queryParams.team_size;
  const sizeList = Array.isArray(rawSize)
    ? rawSize.map(s => String(s).trim()).filter(Boolean)
    : typeof rawSize === 'string' && rawSize.trim()
    ? (rawSize.includes('|') ? rawSize.split('|') : rawSize.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (sizeList.length > 0) {
    const sizeParts = [];
    for (const s of sizeList) {
      const normSize = s
        .toLowerCase()
        .replace(/–/g, '-')
        .replace(/\s+/g, '')
        .replace(/,/g, '')
        .replace(/members?/g, '');
      params.push(normSize);
      const sizeIdx = params.length;
      sizeParts.push(`(
        replace(replace(replace(replace(lower(c.size), ' ', ''), '–', '-'), ',', ''), 'members', '') IN ($${sizeIdx}, $${sizeIdx} || '+', $${sizeIdx} || 'members')
        OR (
          $${sizeIdx} = '10000+' AND replace(replace(replace(replace(lower(c.size), ' ', ''), '–', '-'), ',', ''), 'members', '') IN ('10000+', '10001+', '10000', '10001')
        )
      )`);
    }
    sizeClause = ` AND (${sizeParts.join(' OR ')})`;
  }

  // Optional filter: Actively Hiring (Companies with active jobs posted in the last 30 days or explicitly flagged actively_hiring)
  let activelyHiringClause = '';
  const isActivelyHiring = queryParams.actively_hiring === true || queryParams.actively_hiring === 'true' || queryParams.actively_hiring === '1';
  if (isActivelyHiring) {
    activelyHiringClause = `
      AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.org_id = c.org_id
          AND (j.status = 'ACTIVE' OR j.is_active = TRUE)
          AND (j.expires_at IS NULL OR j.expires_at > NOW())
          AND (j.actively_hiring = TRUE OR j.created_at >= NOW() - INTERVAL '30 days')
      )
    `;
  }

  // Cursor pagination clause against (relevance_score DESC, LOWER(name) ASC, id ASC)
  let cursorClause = '';
  if (parsedCursor) {
    params.push(parsedCursor.s, parsedCursor.n, parsedCursor.id);
    const sIdx = params.length - 2;
    const nIdx = params.length - 1;
    const idIdx = params.length;

    cursorClause = `
      WHERE (
        (cand.relevance_score < $${sIdx})
        OR (cand.relevance_score = $${sIdx} AND LOWER(cand.name) > LOWER($${nIdx}))
        OR (cand.relevance_score = $${sIdx} AND LOWER(cand.name) = LOWER($${nIdx}) AND cand.id > $${idIdx})
      )
    `;
  }

  const fetchLimit = Number(limit) + 1;
  params.push(fetchLimit);
  const limitIdx = params.length;

  let cteDefinitions = '';
  let followCheck = 'FALSE';
  let isSelfSelect = 'FALSE';
  let viewerWorksHereSelect = '0';
  let connectionsWorkingHereSelect = '0';

  if (orgActorParamIdx) {
    // Viewer is an Organization:
    // 1. Never compute personal employment history or personal 1st-degree connections
    // 2. Follow check uses organization_org_follows
    // 3. Self check matches organization ID directly
    followCheck = `EXISTS (SELECT 1 FROM organization_org_follows WHERE follower_org_id = $${orgActorParamIdx} AND following_org_id = c.org_id)`;
    isSelfSelect = `(c.org_id = $${orgActorParamIdx})`;
    viewerWorksHereSelect = '0';
    connectionsWorkingHereSelect = '0';
  } else if (viewerParamIdx) {
    cteDefinitions = `
      viewer_conns AS (
        SELECT connected_user_id AS user_id FROM connections WHERE user_id = $${viewerParamIdx}
        UNION
        SELECT f1.following_id AS user_id
        FROM followers f1
        JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
        WHERE f1.follower_id = $${viewerParamIdx}
      ),
    `;

    followCheck = `EXISTS (SELECT 1 FROM organization_followers ofol WHERE ofol.user_id = $${viewerParamIdx} AND ofol.org_id = c.org_id)`;

    isSelfSelect = `(c.created_by = $${viewerParamIdx} OR EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = c.org_id AND om.user_id = $${viewerParamIdx} AND (om.status = 'ACTIVE' OR om.status IS NULL)))`;

    // 2 = currently working here, 1 = formerly worked here, 0 = none
    viewerWorksHereSelect = `
      COALESCE((
        SELECT CASE
          WHEN bool_or(ex.is_current) THEN 2
          WHEN COUNT(*) > 0 THEN 1
          ELSE 0
        END
        FROM experiences ex
        JOIN profiles p ON ex.profile_id = p.profile_id
        WHERE p.user_id = $${viewerParamIdx}
          AND (
            (ex.org_id IS NOT NULL AND ex.org_id = c.org_id)
            OR (ex.company_name IS NOT NULL AND TRIM(ex.company_name) <> '' AND LOWER(TRIM(ex.company_name)) = LOWER(TRIM(c.name)))
          )
        HAVING COUNT(*) > 0
      ), 0)
    `;

    // Count of viewer's 1st degree connections currently working here
    connectionsWorkingHereSelect = `
      COALESCE((
        SELECT COUNT(DISTINCT vc.user_id)::int
        FROM experiences ex
        JOIN profiles p ON ex.profile_id = p.profile_id
        JOIN viewer_conns vc ON p.user_id = vc.user_id
        WHERE (
          (ex.org_id IS NOT NULL AND ex.org_id = c.org_id)
          OR (ex.company_name IS NOT NULL AND TRIM(ex.company_name) <> '' AND LOWER(TRIM(ex.company_name)) = LOWER(TRIM(c.name)))
        )
          AND ex.is_current = TRUE
      ), 0)
    `;
  }

  const sql = `
    WITH ${cteDefinitions}
    candidate_pool AS (
      SELECT
        c.org_id AS id,
        c.name,
        c.slug,
        c.headline,
        c.industry,
        c.size,
        c.logo_url,
        c.entity_type,
        c.verification_status,
        c.location,
        c.location_formatted,
        c.city,
        c.country,
        ${followCheck} AS is_following,
        COALESCE(ops.message_permission, 'everyone') AS message_permission,
        COALESCE(ons.messages_enabled, TRUE) AS messages_enabled,
        ${isSelfSelect} AS is_self,
        ${viewerWorksHereSelect} AS viewer_employment_status,
        ${connectionsWorkingHereSelect} AS connections_working_here,
        COALESCE((
          SELECT CASE
            WHEN bool_or(j.created_at >= NOW() - INTERVAL '7 days') THEN 40
            WHEN bool_or(j.created_at >= NOW() - INTERVAL '14 days') THEN 25
            WHEN bool_or(j.created_at >= NOW() - INTERVAL '30 days') THEN 15
            ELSE 5
          END
          FROM jobs j
          WHERE j.org_id = c.org_id
            AND (j.status = 'ACTIVE' OR j.is_active = TRUE)
            AND (j.expires_at IS NULL OR j.expires_at > NOW())
          HAVING COUNT(*) > 0
        ), 0) AS hiring_freshness_boost,
        COALESCE((
          SELECT LEAST(COUNT(*)::int, 5) * 5
          FROM jobs j
          WHERE j.org_id = c.org_id
            AND (j.status = 'ACTIVE' OR j.is_active = TRUE)
            AND (j.expires_at IS NULL OR j.expires_at > NOW())
        ), 0) AS hiring_volume_boost,
        CASE
          WHEN LOWER(c.name) = LOWER($3) THEN 150
          WHEN LOWER(c.name) LIKE LOWER($2) THEN 80
          WHEN LOWER(c.name) LIKE LOWER($1) THEN 40
          WHEN LOWER(COALESCE(c.slug, '')) LIKE LOWER($1) THEN 25
          WHEN LOWER(COALESCE(c.industry, '')) LIKE LOWER($1) THEN 20
          WHEN LOWER(COALESCE(c.city, '')) LIKE LOWER($1) OR LOWER(COALESCE(c.location, '')) LIKE LOWER($1) THEN 15
          ELSE 10
        END AS lexical_score
      FROM active_organizations c
      LEFT JOIN organization_privacy_settings ops ON ops.org_id = c.org_id
      LEFT JOIN organization_notification_settings ons ON ons.org_id = c.org_id
      WHERE c.name IS NOT NULL AND TRIM(c.name) <> ''
        AND (c.entity_type IS NULL OR c.entity_type = 'COMPANY')
        AND (
          c.name ILIKE $1 
          OR c.slug ILIKE $1 
          OR c.industry ILIKE $1
          OR c.location ILIKE $1
          OR c.location_formatted ILIKE $1
          OR c.city ILIKE $1
        )
        ${blockFilter}
        ${industryClause}
        ${locationClause}
        ${sizeClause}
        ${activelyHiringClause}
    ),
    scored_candidates AS (
      SELECT
        *,
        (
          lexical_score
          + hiring_freshness_boost
          + hiring_volume_boost
          + (CASE WHEN is_following THEN 60 ELSE 0 END)
          + (CASE 
              WHEN viewer_employment_status = 2 THEN 80
              WHEN viewer_employment_status = 1 THEN 40
              ELSE 0
            END)
          + (LEAST(connections_working_here, 6) * 15)
          + (CASE WHEN verification_status = 'VERIFIED' THEN 30 ELSE 0 END)
        )::int AS relevance_score
      FROM candidate_pool
    )
    SELECT *
    FROM scored_candidates cand
    ${cursorClause}
    ORDER BY cand.relevance_score DESC, LOWER(cand.name) ASC, cand.id ASC
    LIMIT $${limitIdx};
  `;

  const { rows } = await client.query(sql, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeCompanyCursor(lastItem);
  }

  const formattedItems = items.map(item => {
    let contextSignal = null;
    let contextType = null;

    if (orgActorId) {
      // Organization searching for Company:
      // Subtitle priority: Headline -> Industry • Location -> Industry -> Location
      if (item.headline) {
        contextType = 'headline';
        contextSignal = item.headline;
      } else if (item.industry && item.location) {
        contextType = 'industry_location';
        contextSignal = `${item.industry} • ${item.location}`;
      } else if (item.industry) {
        contextType = 'industry';
        contextSignal = item.industry;
      } else {
        const displayLoc = item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null);
        if (displayLoc) {
          contextType = 'location';
          contextSignal = displayLoc;
        }
      }
    } else {
      // User searching for Company:
      // Subtitle priority: Connections -> Employment Status -> Headline -> Industry • Location -> Industry -> Location
      if (item.connections_working_here > 0) {
        contextType = 'connections';
        contextSignal = `${item.connections_working_here} ${item.connections_working_here === 1 ? 'connection works' : 'connections work'} here`;
      } else if (item.viewer_employment_status === 2) {
        contextType = 'employment';
        contextSignal = 'You work here';
      } else if (item.viewer_employment_status === 1) {
        contextType = 'employment';
        contextSignal = 'You previously worked here';
      } else if (item.headline) {
        contextType = 'headline';
        contextSignal = item.headline;
      } else if (item.industry && item.location) {
        contextType = 'industry_location';
        contextSignal = `${item.industry} • ${item.location}`;
      } else if (item.industry) {
        contextType = 'industry';
        contextSignal = item.industry;
      } else {
        const displayLoc = item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null);
        if (displayLoc) {
          contextType = 'location';
          contextSignal = displayLoc;
        }
      }
    }

    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      headline: item.headline || null,
      industry: item.industry || 'Company',
      size: item.size,
      logo: item.logo_url,
      logo_url: item.logo_url,
      entity_type: item.entity_type || 'COMPANY',
      verification_status: item.verification_status,
      is_verified: item.verification_status === 'VERIFIED',
      location: item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null),
      is_following: Boolean(item.is_following),
      message_permission: item.message_permission || 'everyone',
      messages_enabled: item.messages_enabled !== false,
      is_self: Boolean(item.is_self),
      can_message: Boolean(item.is_following && item.message_permission !== 'no_one' && item.messages_enabled !== false),
      context_signal: contextSignal,
      context_type: contextType,
      relevance_score: item.relevance_score,
    };
  });

  return {
    items: formattedItems,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

module.exports = {
  searchCompanies,
  encodeCompanyCursor,
  decodeCompanyCursor,
};
