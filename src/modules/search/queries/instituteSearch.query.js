/**
 * Institute Search Query for COCPIT Global Search
 * Queries active_organizations where entity_type = 'INSTITUTION' with LinkedIn-style multi-signal ranking:
 * 1. Lexical match (Exact match > Prefix match > Substring match)
 * 2. Viewer education history ("You studied here")
 * 3. 1st-degree network alumni density ("X alumni in your network")
 * 4. Viewer follow status (organization_followers)
 * 5. Verified education status (verified_edu / verification_status)
 *
 * Implements deterministic keyset cursor pagination on (relevance_score, name, org_id).
 */

/**
 * Encodes keyset cursor for institute pagination
 */
function encodeInstituteCursor(item) {
  if (!item) return null;
  const payload = {
    s: typeof item.relevance_score === 'number' ? item.relevance_score : (item.sort_rank === 0 ? 100 : 20),
    n: item.name || '',
    id: item.id || item.org_id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes and validates keyset cursor for institutes
 */
function decodeInstituteCursor(cursor) {
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

/**
 * Executes institute search query with multi-signal ranking
 */
async function searchInstitutes(client, { searchTerm, viewerId = null, orgActorId = null, limit = 10, cursor = null, queryParams = {} }) {
  const trimmed = searchTerm.trim().replace(/^['"]|['"]$/g, '');
  const likeTerm = `%${trimmed}%`;
  const prefixTerm = `${trimmed}%`;
  const parsedCursor = decodeInstituteCursor(cursor);

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

  // Optional filters: institute_type / type, location, and org size (supporting multi-selection)
  let instituteTypeClause = '';
  const rawType = queryParams.type || queryParams.org_type || queryParams.institute_type || queryParams.institution_type;
  const itypeList = Array.isArray(rawType)
    ? rawType.map(s => String(s).trim()).filter(Boolean)
    : typeof rawType === 'string' && rawType.trim()
    ? (rawType.includes('|') ? rawType.split('|') : rawType.split(',')).map(s => s.trim()).filter(Boolean)
    : [];

  if (itypeList.length > 0) {
    const typeParts = [];
    for (const itype of itypeList) {
      params.push(`%${itype}%`);
      const itypeIdx = params.length;
      typeParts.push(`c.institution_type ILIKE $${itypeIdx}`);
    }
    instituteTypeClause = ` AND (${typeParts.join(' OR ')})`;
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
        `c.campus_location ILIKE $${locIdx}`,
        `c.location ILIKE $${locIdx}`,
        `c.location_formatted ILIKE $${locIdx}`,
        `c.city ILIKE $${locIdx}`,
        `c.country ILIKE $${locIdx}`,
        `c.campus_location ILIKE $${primaryIdx}`,
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
        subClauses.push(`c.campus_location ILIKE $${bIdx}`, `c.location ILIKE $${bIdx}`, `c.city ILIKE $${bIdx}`, `c.location_formatted ILIKE $${bIdx}`);
      } else if (lowerPrimary === 'bangalore') {
        params.push('%Bengaluru%');
        const bIdx = params.length;
        subClauses.push(`c.campus_location ILIKE $${bIdx}`, `c.location ILIKE $${bIdx}`, `c.city ILIKE $${bIdx}`, `c.location_formatted ILIKE $${bIdx}`);
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
  let viewerStudiedHereSelect = 'FALSE';
  let alumniInNetworkSelect = '0';

  if (orgActorParamIdx) {
    // Viewer is an Organization:
    // 1. Never compute personal education / alumni signals
    // 2. Follow check uses organization_org_follows
    // 3. Self check matches organization ID directly
    followCheck = `EXISTS (SELECT 1 FROM organization_org_follows WHERE follower_org_id = $${orgActorParamIdx} AND following_org_id = c.org_id)`;
    isSelfSelect = `(c.org_id = $${orgActorParamIdx})`;
    viewerStudiedHereSelect = 'FALSE';
    alumniInNetworkSelect = '0';
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

    // Check if viewer studied at this institution
    viewerStudiedHereSelect = `
      EXISTS (
        SELECT 1 FROM educations ed
        JOIN profiles p ON ed.profile_id = p.profile_id
        WHERE p.user_id = $${viewerParamIdx}
          AND (ed.school_org_id = c.org_id OR LOWER(TRIM(ed.school_name)) = LOWER(TRIM(c.name)))
      )
    `;

    // Count of viewer's 1st-degree connections who studied at this institution
    alumniInNetworkSelect = `
      COALESCE((
        SELECT COUNT(DISTINCT vc.user_id)::int
        FROM educations ed
        JOIN profiles p ON ed.profile_id = p.profile_id
        JOIN viewer_conns vc ON p.user_id = vc.user_id
        WHERE (ed.school_org_id = c.org_id OR LOWER(TRIM(ed.school_name)) = LOWER(TRIM(c.name)))
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
        c.institution_type,
        c.campus_location,
        c.location,
        c.location_formatted,
        c.city,
        c.country,
        c.size,
        c.logo_url,
        c.entity_type,
        c.verification_status,
        c.verified_edu,
        ${followCheck} AS is_following,
        COALESCE(ops.message_permission, 'everyone') AS message_permission,
        COALESCE(ons.messages_enabled, TRUE) AS messages_enabled,
        ${isSelfSelect} AS is_self,
        ${viewerStudiedHereSelect} AS viewer_studied_here,
        ${alumniInNetworkSelect} AS alumni_in_network,
        CASE
          WHEN LOWER(c.name) = LOWER($3) THEN 150
          WHEN LOWER(c.name) LIKE LOWER($2) THEN 80
          WHEN LOWER(c.name) LIKE LOWER($1) THEN 40
          WHEN LOWER(COALESCE(c.slug, '')) LIKE LOWER($1) THEN 25
          WHEN LOWER(COALESCE(c.institution_type, '')) LIKE LOWER($1) THEN 20
          WHEN LOWER(COALESCE(c.campus_location, '')) LIKE LOWER($1) THEN 20
          WHEN LOWER(COALESCE(c.city, '')) LIKE LOWER($1) OR LOWER(COALESCE(c.location, '')) LIKE LOWER($1) THEN 15
          ELSE 10
        END AS lexical_score
      FROM active_organizations c
      LEFT JOIN organization_privacy_settings ops ON ops.org_id = c.org_id
      LEFT JOIN organization_notification_settings ons ON ons.org_id = c.org_id
      WHERE c.name IS NOT NULL AND TRIM(c.name) <> ''
        AND c.entity_type = 'INSTITUTION'
        AND (
          c.name ILIKE $1 
          OR c.slug ILIKE $1 
          OR c.institution_type ILIKE $1
          OR c.campus_location ILIKE $1
          OR c.location ILIKE $1
          OR c.location_formatted ILIKE $1
          OR c.city ILIKE $1
        )
        ${blockFilter}
        ${instituteTypeClause}
        ${locationClause}
        ${sizeClause}
    ),
    scored_candidates AS (
      SELECT
        *,
        (
          lexical_score
          + (CASE WHEN viewer_studied_here THEN 100 ELSE 0 END)
          + (LEAST(alumni_in_network, 6) * 15)
          + (CASE WHEN is_following THEN 60 ELSE 0 END)
          + (CASE WHEN (verified_edu = TRUE OR verification_status = 'VERIFIED') THEN 30 ELSE 0 END)
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
    nextCursor = encodeInstituteCursor(lastItem);
  }

  const formattedItems = items.map(item => {
    let contextSignal = null;
    let contextType = null;

    if (orgActorId) {
      // Organization searching for Institute:
      // Subtitle priority: Headline -> Type • Location -> Type -> Location
      if (item.headline) {
        contextType = 'headline';
        contextSignal = item.headline;
      } else if (item.institution_type && (item.campus_location || item.location || item.location_formatted)) {
        contextType = 'type_location';
        contextSignal = `${item.institution_type} • ${item.campus_location || item.location || item.location_formatted}`;
      } else if (item.institution_type) {
        contextType = 'type';
        contextSignal = item.institution_type;
      } else {
        const displayLoc = item.campus_location || item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null);
        if (displayLoc) {
          contextType = 'location';
          contextSignal = displayLoc;
        }
      }
    } else {
      // User searching for Institute:
      // Subtitle priority: Studied Here -> Alumni in Network -> Headline -> Type • Location -> Type -> Location
      if (item.viewer_studied_here) {
        contextType = 'studied_here';
        contextSignal = 'You studied here';
      } else if (item.alumni_in_network > 0) {
        contextType = 'alumni_network';
        contextSignal = `${item.alumni_in_network} ${item.alumni_in_network === 1 ? 'alumnus' : 'alumni'} in your network`;
      } else if (item.headline) {
        contextType = 'headline';
        contextSignal = item.headline;
      } else if (item.institution_type && (item.campus_location || item.location || item.location_formatted)) {
        contextType = 'type_location';
        contextSignal = `${item.institution_type} • ${item.campus_location || item.location || item.location_formatted}`;
      } else if (item.institution_type) {
        contextType = 'type';
        contextSignal = item.institution_type;
      } else {
        const displayLoc = item.campus_location || item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null);
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
      institution_type: item.institution_type || 'Institute',
      size: item.size,
      logo: item.logo_url,
      logo_url: item.logo_url,
      entity_type: item.entity_type,
      verification_status: item.verification_status,
      is_verified: Boolean(item.verified_edu || item.verification_status === 'VERIFIED'),
      location: item.campus_location || item.location || item.location_formatted || (item.city ? `${item.city}${item.country ? `, ${item.country}` : ''}` : null),
      campus_location: item.campus_location,
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
  searchInstitutes,
  encodeInstituteCursor,
  decodeInstituteCursor,
};
