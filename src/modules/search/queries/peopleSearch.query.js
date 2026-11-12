/**
 * People Search Query for COCPIT Global Search
 * Queries active_users with LinkedIn-style multi-signal ranking:
 * 1. Lexical match (Exact match > Prefix match > Substring match)
 * 2. 1st-degree connection / Follow status
 * 3. 2nd-degree mutual connections density (capped curve)
 * 4. Shared educational institution (alumni)
 * 5. Shared past/current employer
 * 6. Shared profile skills
 * 7. Geographic proximity (same city)
 *
 * Implements deterministic keyset cursor pagination on (relevance_score, full_name, user_id).
 */

/**
 * Encodes keyset cursor for people pagination
 */
function encodePeopleCursor(item) {
  if (!item) return null;
  const payload = {
    s: typeof item.relevance_score === 'number' ? item.relevance_score : 0,
    n: item.name || item.full_name || '',
    id: item.id || item.user_id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes and validates keyset cursor for people
 */
function decodePeopleCursor(cursor) {
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
    // Backward compatibility for previous cursor format { r, n, id }
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

/**
 * Executes people search query with multi-signal LinkedIn ranking
 */
async function searchPeople(client, { searchTerm, viewerId, orgActorId = null, limit = 10, cursor = null, queryParams = {} }) {
  const trimmed = searchTerm.trim().replace(/^['"]|['"]$/g, '');
  const likeTerm = `%${trimmed}%`;
  const prefixTerm = `${trimmed}%`;
  const parsedCursor = decodePeopleCursor(cursor);

  // Core search parameters: $1 = likeTerm, $2 = prefixTerm, $3 = trimmed
  const params = [likeTerm, prefixTerm, trimmed];
  let viewerParamIdx = null;
  let orgParamIdx = null;

  if (viewerId) {
    params.push(viewerId);
    viewerParamIdx = params.length;
  } else if (orgActorId) {
    params.push(orgActorId);
    orgParamIdx = params.length;
  }

  // Bidirectional block filter
  let blockFilter = '';
  if (viewerParamIdx) {
    blockFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE b.is_org_block = false
          AND ((b.blocker_id = $${viewerParamIdx} AND b.blocked_id = u.user_id)
            OR (b.blocker_id = u.user_id AND b.blocked_id = $${viewerParamIdx}))
      )
    `;
  } else if (orgParamIdx) {
    blockFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE ((b.blocker_id = $${orgParamIdx} AND b.blocked_id = u.user_id)
          OR (b.blocker_id = u.user_id AND b.blocked_id = $${orgParamIdx}))
      )
    `;
  }

  // Optional filters: location, role, company (supporting multi-selection)
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
        `u.location ILIKE $${locIdx}`,
        `u.location_formatted ILIKE $${locIdx}`,
        `u.location_city ILIKE $${locIdx}`,
        `u.location_state ILIKE $${locIdx}`,
        `u.location_country ILIKE $${locIdx}`,
        `u.location ILIKE $${primaryIdx}`,
        `u.location_formatted ILIKE $${primaryIdx}`,
        `u.location_city ILIKE $${primaryIdx}`,
        `(COALESCE(u.location_city, '') || ', ' || COALESCE(u.location_state, '') || ', ' || COALESCE(u.location_country, '')) ILIKE $${locIdx}`,
        `(COALESCE(u.location_city, '') || ', ' || COALESCE(u.location_country, '')) ILIKE $${locIdx}`
      ];

      // City aliases (e.g. Bangalore / Bengaluru)
      const lowerPrimary = primary.toLowerCase();
      if (lowerPrimary === 'bengaluru') {
        params.push('%Bangalore%');
        const bIdx = params.length;
        subClauses.push(`u.location ILIKE $${bIdx}`, `u.location_city ILIKE $${bIdx}`, `u.location_formatted ILIKE $${bIdx}`);
      } else if (lowerPrimary === 'bangalore') {
        params.push('%Bengaluru%');
        const bIdx = params.length;
        subClauses.push(`u.location ILIKE $${bIdx}`, `u.location_city ILIKE $${bIdx}`, `u.location_formatted ILIKE $${bIdx}`);
      }

      locParts.push(`(${subClauses.join(' OR ')})`);
    }
    locationClause = ` AND (${locParts.join(' OR ')})`;
  }

  let roleClause = '';
  const rawRole = queryParams.role;
  const roleList = Array.isArray(rawRole)
    ? rawRole.map(s => String(s).trim()).filter(Boolean)
    : typeof rawRole === 'string' && rawRole.trim()
    ? (rawRole.includes('|') ? rawRole.split('|') : rawRole.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (roleList.length > 0) {
    const roleParts = [];
    for (const role of roleList) {
      params.push(`%${role}%`);
      const roleIdx = params.length;

      roleParts.push(`(
        u.headline ILIKE $${roleIdx}
        OR EXISTS (
          SELECT 1 FROM experiences exp
          WHERE exp.profile_id = p.profile_id
            AND exp.title ILIKE $${roleIdx}
        )
      )`);
    }
    roleClause = ` AND (${roleParts.join(' OR ')})`;
  }

  let companyClause = '';
  const rawComp = queryParams.company;
  const compList = Array.isArray(rawComp)
    ? rawComp.map(s => String(s).trim()).filter(Boolean)
    : typeof rawComp === 'string' && rawComp.trim()
    ? (rawComp.includes('|') ? rawComp.split('|') : rawComp.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (compList.length > 0) {
    const compParts = [];
    for (const comp of compList) {
      params.push(`%${comp}%`);
      const compIdx = params.length;

      compParts.push(`(
        u.headline ILIKE $${compIdx}
        OR EXISTS (
          SELECT 1 FROM experiences exp
          LEFT JOIN organizations org ON exp.org_id = org.org_id
          WHERE exp.profile_id = p.profile_id
            AND (
              exp.company_name ILIKE $${compIdx}
              OR org.name ILIKE $${compIdx}
            )
        )
      )`);
    }
    companyClause = ` AND (${compParts.join(' OR ')})`;
  }

  // Optional filter: Industry / Industry Type
  let industryClause = '';
  const rawInd = queryParams.industry || queryParams.industry_type;
  const indList = Array.isArray(rawInd)
    ? rawInd.map(s => String(s).trim()).filter(Boolean)
    : typeof rawInd === 'string' && rawInd.trim()
    ? (rawInd.includes('|') ? rawInd.split('|') : rawInd.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (indList.length > 0) {
    const indParts = [];
    for (const ind of indList) {
      params.push(`%${ind}%`);
      const indIdx = params.length;

      indParts.push(`(
        p.working_industry ILIKE $${indIdx}
        OR EXISTS (
          SELECT 1 FROM experiences exp
          LEFT JOIN organizations org ON exp.org_id = org.org_id
          WHERE exp.profile_id = p.profile_id
            AND org.industry ILIKE $${indIdx}
        )
      )`);
    }
    industryClause = ` AND (${indParts.join(' OR ')})`;
  }

  // Optional filter: Institute / School / Institution
  let instituteClause = '';
  const rawInst = queryParams.institute || queryParams.school || queryParams.institution;
  const instList = Array.isArray(rawInst)
    ? rawInst.map(s => String(s).trim()).filter(Boolean)
    : typeof rawInst === 'string' && rawInst.trim()
    ? (rawInst.includes('|') ? rawInst.split('|') : rawInst.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (instList.length > 0) {
    const instParts = [];
    for (const inst of instList) {
      params.push(`%${inst}%`);
      const instIdx = params.length;

      instParts.push(`(
        EXISTS (
          SELECT 1 FROM educations ed
          LEFT JOIN organizations org ON ed.school_org_id = org.org_id
          WHERE ed.profile_id = p.profile_id
            AND (
              ed.school_name ILIKE $${instIdx}
              OR org.name ILIKE $${instIdx}
            )
        )
      )`);
    }
    instituteClause = ` AND (${instParts.join(' OR ')})`;
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
        (c.relevance_score < $${sIdx})
        OR (c.relevance_score = $${sIdx} AND LOWER(c.name) > LOWER($${nIdx}))
        OR (c.relevance_score = $${sIdx} AND LOWER(c.name) = LOWER($${nIdx}) AND c.id > $${idIdx})
      )
    `;
  }

  const fetchLimit = Number(limit) + 1;
  params.push(fetchLimit);
  const limitIdx = params.length;

  let cteDefinitions = '';
  let followCheck = 'FALSE';
  let connectionStatusSelect = `'none'`;
  let pendingRequestIdSelect = 'NULL::uuid';
  let isSelfSelect = 'FALSE';
  let mutualConnectionsSelect = '0';
  let mutualAvatarsSelect = `'[]'::json`;
  let sharedSchoolSelect = 'NULL::text';
  let sharedCompanySelect = 'NULL::text';
  let sharedSkillSelect = 'NULL::text';
  let sameCitySelect = 'FALSE';

  if (orgParamIdx) {
    followCheck = `EXISTS (SELECT 1 FROM organization_user_follows ouf WHERE ouf.org_id = $${orgParamIdx} AND ouf.user_id = u.user_id)`;
    connectionStatusSelect = `'none'`;
    pendingRequestIdSelect = 'NULL::uuid';
    isSelfSelect = 'FALSE';
    mutualConnectionsSelect = '0';
    mutualAvatarsSelect = `'[]'::json`;
  } else if (viewerParamIdx) {
    cteDefinitions = `
      viewer_info AS (
        SELECT COALESCE(u.location_city, SPLIT_PART(u.location, ',', 1)) AS location_city, p.profile_id
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.user_id
        WHERE u.user_id = $${viewerParamIdx}
      ),
      viewer_conns AS (
        SELECT connected_user_id AS user_id FROM connections WHERE user_id = $${viewerParamIdx}
        UNION
        SELECT f1.following_id AS user_id
        FROM followers f1
        JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
        WHERE f1.follower_id = $${viewerParamIdx}
      ),
      viewer_schools AS (
        SELECT DISTINCT LOWER(TRIM(ed.school_name)) AS school_name, ed.school_org_id
        FROM educations ed
        JOIN viewer_info vi ON ed.profile_id = vi.profile_id
        WHERE ed.school_name IS NOT NULL AND TRIM(ed.school_name) <> ''
      ),
      viewer_companies AS (
        SELECT DISTINCT LOWER(TRIM(ex.company_name)) AS company_name, ex.org_id
        FROM experiences ex
        JOIN viewer_info vi ON ex.profile_id = vi.profile_id
        WHERE ex.company_name IS NOT NULL AND TRIM(ex.company_name) <> ''
      ),
      viewer_skills AS (
        SELECT DISTINCT us.skill_id, sk.name AS skill_name
        FROM user_skills us
        JOIN viewer_info vi ON us.profile_id = vi.profile_id
        JOIN skills sk ON us.skill_id = sk.skill_id
      ),
    `;

    followCheck = `EXISTS (SELECT 1 FROM followers f WHERE f.follower_id = $${viewerParamIdx} AND f.following_id = u.user_id)`;

    connectionStatusSelect = `
      CASE
        WHEN EXISTS (SELECT 1 FROM connections c_rel WHERE (c_rel.user_id = $${viewerParamIdx} AND c_rel.connected_user_id = u.user_id) OR (c_rel.user_id = u.user_id AND c_rel.connected_user_id = $${viewerParamIdx})) THEN 'connected'
        WHEN EXISTS (SELECT 1 FROM connection_requests cr_sent WHERE cr_sent.sender_id = $${viewerParamIdx} AND cr_sent.receiver_id = u.user_id AND cr_sent.status = 'pending') THEN 'pending_sent'
        WHEN EXISTS (SELECT 1 FROM connection_requests cr_rec WHERE cr_rec.sender_id = u.user_id AND cr_rec.receiver_id = $${viewerParamIdx} AND cr_rec.status = 'pending') THEN 'pending_received'
        ELSE 'none'
      END
    `;

    pendingRequestIdSelect = `
      (
        SELECT cr_id.request_id 
        FROM connection_requests cr_id 
        WHERE cr_id.status = 'pending' 
          AND ((cr_id.sender_id = $${viewerParamIdx} AND cr_id.receiver_id = u.user_id) 
            OR (cr_id.sender_id = u.user_id AND cr_id.receiver_id = $${viewerParamIdx}))
        LIMIT 1
      )
    `;

    isSelfSelect = `(u.user_id = $${viewerParamIdx})`;

    mutualConnectionsSelect = `
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT c.connected_user_id AS mut_id
          FROM connections c
          WHERE c.user_id = u.user_id AND c.connected_user_id IN (SELECT user_id FROM viewer_conns)
          UNION
          SELECT f1.following_id AS mut_id
          FROM followers f1
          JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
          WHERE f1.follower_id = u.user_id AND f1.following_id IN (SELECT user_id FROM viewer_conns)
        ) m
      )
    `;

    mutualAvatarsSelect = `
      COALESCE((
        SELECT json_agg(avatar_data)
        FROM (
          SELECT mut.avatar_url
          FROM (
            SELECT c.connected_user_id AS mut_id
            FROM connections c
            WHERE c.user_id = u.user_id AND c.connected_user_id IN (SELECT user_id FROM viewer_conns)
            UNION
            SELECT f1.following_id AS mut_id
            FROM followers f1
            JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
            WHERE f1.follower_id = u.user_id AND f1.following_id IN (SELECT user_id FROM viewer_conns)
          ) m
          JOIN active_users mut ON mut.user_id = m.mut_id
          WHERE mut.avatar_url IS NOT NULL AND TRIM(mut.avatar_url) <> ''
          LIMIT 3
        ) avatar_data
      ), '[]'::json)
    `;

    sharedSchoolSelect = `
      (
        SELECT ed.school_name
        FROM educations ed
        JOIN profiles p_cand ON ed.profile_id = p_cand.profile_id
        WHERE p_cand.user_id = u.user_id
          AND (
            (ed.school_org_id IS NOT NULL AND ed.school_org_id IN (SELECT school_org_id FROM viewer_schools WHERE school_org_id IS NOT NULL))
            OR LOWER(TRIM(ed.school_name)) IN (SELECT school_name FROM viewer_schools)
          )
        LIMIT 1
      )
    `;

    sharedCompanySelect = `
      (
        SELECT ex.company_name
        FROM experiences ex
        JOIN profiles p_cand ON ex.profile_id = p_cand.profile_id
        WHERE p_cand.user_id = u.user_id
          AND (
            (ex.org_id IS NOT NULL AND ex.org_id IN (SELECT org_id FROM viewer_companies WHERE org_id IS NOT NULL))
            OR LOWER(TRIM(ex.company_name)) IN (SELECT company_name FROM viewer_companies)
          )
        LIMIT 1
      )
    `;

    sharedSkillSelect = `
      (
        SELECT vs.skill_name
        FROM user_skills us
        JOIN profiles p_cand ON us.profile_id = p_cand.profile_id
        JOIN viewer_skills vs ON us.skill_id = vs.skill_id
        WHERE p_cand.user_id = u.user_id
        LIMIT 1
      )
    `;

    sameCitySelect = `
      (
        COALESCE(u.location_city, SPLIT_PART(u.location, ',', 1)) IS NOT NULL 
        AND LOWER(TRIM(COALESCE(u.location_city, SPLIT_PART(u.location, ',', 1)))) = (SELECT LOWER(TRIM(location_city)) FROM viewer_info WHERE location_city IS NOT NULL)
      )
    `;
  }

  const sql = `
    WITH ${cteDefinitions}
    candidate_pool AS (
      SELECT
        u.user_id AS id,
        u.full_name AS name,
        u.account_name,
        u.headline,
        u.avatar_url,
        u.location,
        u.location_formatted,
        u.location_city,
        u.location_state,
        u.location_country,
        p.account_type,
        ${followCheck} AS is_following,
        (SELECT COUNT(*)::int FROM connections c_cnt WHERE c_cnt.user_id = u.user_id) AS connections_count,
        ${connectionStatusSelect} AS connection_status,
        ${pendingRequestIdSelect} AS pending_request_id,
        ${isSelfSelect} AS is_self,
        ${mutualConnectionsSelect} AS mutual_connections,
        ${mutualAvatarsSelect} AS mutual_avatars,
        ${sharedSchoolSelect} AS shared_school,
        ${sharedCompanySelect} AS shared_company,
        ${sharedSkillSelect} AS shared_skill,
        ${sameCitySelect} AS same_city,
        CASE 
          WHEN LOWER(u.full_name) = LOWER($3) THEN 200
          WHEN LOWER(u.full_name) LIKE LOWER($2) THEN 100
          WHEN LOWER(u.full_name) LIKE LOWER($1) THEN 50
          WHEN LOWER(COALESCE(u.headline, '')) LIKE LOWER($1) THEN 35
          WHEN LOWER(COALESCE(u.location_city, '')) LIKE LOWER($1) OR LOWER(COALESCE(u.location, '')) LIKE LOWER($1) THEN 25
          ELSE 20
        END AS lexical_score
      FROM active_users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.is_deactivated = FALSE
        AND u.full_name IS NOT NULL AND TRIM(u.full_name) <> ''
        AND (
          u.full_name ILIKE $1 
          OR u.account_name ILIKE $1 
          OR u.headline ILIKE $1
          OR u.location ILIKE $1
          OR u.location_formatted ILIKE $1
          OR u.location_city ILIKE $1
        )
        ${blockFilter}
        ${locationClause}
        ${roleClause}
        ${companyClause}
        ${industryClause}
        ${instituteClause}
    ),
    scored_candidates AS (
      SELECT
        *,
        (
          lexical_score
          + (CASE WHEN is_following THEN 60 ELSE 0 END)
          + (LEAST(mutual_connections, 10) * 12)
          + (CASE WHEN shared_school IS NOT NULL THEN 40 ELSE 0 END)
          + (CASE WHEN shared_company IS NOT NULL THEN 25 ELSE 0 END)
          + (CASE WHEN shared_skill IS NOT NULL THEN 15 ELSE 0 END)
          + (CASE WHEN same_city THEN 10 ELSE 0 END)
        )::int AS relevance_score
      FROM candidate_pool
    )
    SELECT *
    FROM scored_candidates c
    ${cursorClause}
    ORDER BY c.relevance_score DESC, LOWER(c.name) ASC, c.id ASC
    LIMIT $${limitIdx};
  `;

  const { rows } = await client.query(sql, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodePeopleCursor(lastItem);
  }

  const formattedItems = items.map(item => {
    let contextSignal = null;
    let contextType = null;

    if (item.mutual_connections > 0) {
      contextType = 'mutuals';
      contextSignal = `${item.mutual_connections} ${item.mutual_connections === 1 ? 'mutual' : 'mutuals'}`;
    } else if (item.shared_school) {
      contextType = 'education';
      contextSignal = `Both attended ${item.shared_school}`;
    } else if (item.shared_company) {
      contextType = 'company';
      contextSignal = `Both worked at ${item.shared_company}`;
    } else if (item.shared_skill) {
      contextType = 'skill';
      contextSignal = `Shared interest in ${item.shared_skill}`;
    } else {
      const resolvedCity = item.location_city || (item.location ? item.location.split(',')[0].trim() : null) || (item.location_formatted ? item.location_formatted.split(',')[0].trim() : null);
      if (resolvedCity) {
        contextType = 'location';
        contextSignal = `Based in ${resolvedCity}`;
      }
    }

    let mutualAvatars = [];
    if (Array.isArray(item.mutual_avatars)) {
      mutualAvatars = item.mutual_avatars
        .map(a => (typeof a === 'object' && a !== null ? a.avatar_url : a))
        .filter(url => typeof url === 'string' && url.trim().length > 0);
    }

    const resolvedCity = item.location_city || (item.location ? item.location.split(',')[0].trim() : null);

    return {
      id: item.id,
      name: item.name,
      account_name: item.account_name,
      headline: item.headline,
      avatar_url: item.avatar_url,
      location: item.location || item.location_formatted || (item.location_city ? `${item.location_city}${item.location_country ? `, ${item.location_country}` : ''}` : null),
      location_city: resolvedCity,
      is_following: Boolean(item.is_following),
      connections_count: Number(item.connections_count) || 0,
      connection_status: item.connection_status || 'none',
      pending_request_id: item.pending_request_id || null,
      is_self: Boolean(item.is_self),
      is_connected: item.connection_status === 'connected',
      has_pending_request: item.connection_status === 'pending_sent' || item.connection_status === 'pending_received',
      mutual_connections: Number(item.mutual_connections) || 0,
      mutual_avatars: mutualAvatars,
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
  searchPeople,
  encodePeopleCursor,
  decodePeopleCursor,
};
