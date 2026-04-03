-- Schema for user_hashtag_scores recommendation tracking
CREATE TABLE IF NOT EXISTS user_hashtag_scores (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    hashtag_id UUID NOT NULL REFERENCES hashtags(hashtag_id) ON DELETE CASCADE,
    score INT DEFAULT 0 NOT NULL,
    last_updated TIMESTAMP DEFAULT NOW() NOT NULL,
    PRIMARY KEY (user_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS idx_user_hashtag_scores_score ON user_hashtag_scores(score DESC);
