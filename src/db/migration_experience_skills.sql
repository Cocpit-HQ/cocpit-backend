CREATE TABLE IF NOT EXISTS experience_skills (
    experience_id UUID REFERENCES experiences(experience_id) ON DELETE CASCADE,
    skill_id INT REFERENCES skills(skill_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (experience_id, skill_id)
);
