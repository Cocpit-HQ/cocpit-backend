/**
 * Global Search Controller for COCPIT
 * Handles input validation, actor resolution, and JSON response formatting.
 */
const searchService = require('./search.service');

const VALID_TYPES = ['all', 'people', 'jobs', 'companies', 'institutes', 'posts', 'hashtags'];

exports.globalSearch = async (req, res, next) => {
  try {
    const { q, type = 'all', limit, cursor, ...otherParams } = req.query;

    // 1. Validation of search query
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Search query parameter 'q' is required.",
      });
    }

    const trimmedQuery = q.trim();
    if (trimmedQuery.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Search query 'q' exceeds maximum length of 100 characters.",
      });
    }

    // 2. Validation of search category type
    const normalizedType = type.toLowerCase();
    if (!VALID_TYPES.includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid search type '${type}'. Supported types: ${VALID_TYPES.join(', ')}.`,
      });
    }

    // 3. Validation of limit
    let parsedLimit = normalizedType === 'all' ? 3 : 10;
    if (limit !== undefined) {
      const num = parseInt(limit, 10);
      if (isNaN(num) || num < 1 || num > 50) {
        return res.status(400).json({
          success: false,
          message: "Parameter 'limit' must be an integer between 1 and 50.",
        });
      }
      parsedLimit = num;
    }

    // 4. Resolve Actor Context
    let actor = req.actor || null;
    const authUserId = req.user?.sub || req.user?.userId || req.user?.id || actor?.userId || null;
    if (!actor && req.user) {
      actor = {
        type: 'USER',
        userId: authUserId,
      };
    } else if (actor && !actor.userId && authUserId) {
      actor.userId = authUserId;
    }

    // 5. Delegate to Search Orchestrator
    const result = await searchService.executeSearch({
      q: trimmedQuery,
      type: normalizedType,
      limit: parsedLimit,
      cursor: cursor || null,
      queryParams: otherParams,
      actor,
      userId: authUserId,
    });

    return res.status(200).json({
      success: true,
      data: result,
      ...result,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      });
    }
    console.error('[GlobalSearchController] Error executing search:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while executing the search request.',
    });
  }
};
