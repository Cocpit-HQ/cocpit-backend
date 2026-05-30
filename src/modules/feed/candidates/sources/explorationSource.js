/**
 * explorationSource.js
 * COCPIT Feed Engine — Exploration Candidate Source
 *
 * Returns candidates outside the user's immediate social graph to
 * introduce serendipity and help users discover new content/people.
 */

'use strict';

/**
 * getExplorationCandidates
 *
 * Fetches candidate feed items from the exploration pool (discovery content).
 *
 * @param {object} params
 * @param {string} params.userId  - The requesting user's UUID (for interest-based sampling later)
 * @param {number} params.limit   - Maximum number of candidates to return
 * @param {object} params.pool    - pg Pool instance (read-only queries)
 * @returns {Promise<Array>}      - Array of raw candidate rows (empty by design; explore handled via explorationPool)
 */
async function getExplorationCandidates({ userId, limit, pool }) {
  try {
    void userId;
    void limit;
    void pool;

    return [];
  } catch (err) {
    console.error('[explorationSource] Failed fetching exploration candidates:', err.message);
    return [];
  }
}

module.exports = { getExplorationCandidates };
