/**
 * Determines the user persona type based on intent scores and activity.
 * 
 * Logic (as per Step 6):
 * 1. Consumer Fallback: job_seeker < 5, creator < 8, event < 5
 * 2. Creator Priority: If hasCreatedPost is true
 * 3. Weighted Winner: Compare Job Seeker and Event scores
 * 
 * @param {Object} intent - User intent scores {job_seeker_score, creator_score, event_score}
 * @param {Boolean} hasCreatedPost - Whether the user has ever created a post
 * @returns {String} "consumer" | "creator" | "job_seeker" | "event"
 */
const getUserType = (intent, hasCreatedPost) => {
    const { job_seeker_score = 0, creator_score = 0, event_score = 0 } = intent;
  
    // Consumer fallback (low score in all categories)
    if (
      job_seeker_score < 5 &&
      creator_score < 8 &&
      event_score < 5
    ) return "consumer";
  
    // Creator ONLY if created post
    if (hasCreatedPost) return "creator";
  
    // Weighted competition between Job Seeker and Event
    const scores = {
      job_seeker: job_seeker_score,
      event: event_score,
    };
  
    return Object.keys(scores).reduce((a, b) =>
      scores[a] >= scores[b] ? a : b
    );
};

module.exports = {
    getUserType
};
