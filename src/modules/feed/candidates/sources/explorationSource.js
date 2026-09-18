/**
 * explorationSource.js
 * COCPIT Feed Engine — Exploration Candidate Source
 *
 * Returns candidates outside the user's immediate social graph to
 * introduce serendipity and help users discover new content/people.
 */

'use strict';

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: UNUSED / STUB
// - Technical Reason: This file was scaffolded as a placeholder returning [].
// - Active Replacement: Real serendipity/exploration candidates are generated
//   dynamically via src/modules/feed/exploration/explorationPool.js using Redis
//   sorted sets (feed:explore:pool) refreshed every 5 minutes by feedWorker.js.
// ===========================================================================
/*
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
*/
module.exports = { getExplorationCandidates: async () => [] };
