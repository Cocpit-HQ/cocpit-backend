-- ==========================================================================
-- PROFILE PROJECTS FEATURE MIGRATION (2026-07-28)
-- Idempotent script to apply against running PostgreSQL databases.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    details TEXT,
    start_month VARCHAR(20) NOT NULL,
    start_year VARCHAR(10) NOT NULL,
    end_month VARCHAR(20),
    end_year VARCHAR(10),
    is_current BOOLEAN DEFAULT FALSE,
    role VARCHAR(100),
    team_size VARCHAR(50),
    role_description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT chk_projects_date_range CHECK (
        is_current = true OR (end_year IS NOT NULL AND end_month IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_projects_profile_id ON projects(profile_id);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

CREATE TABLE IF NOT EXISTS project_skills (
    project_id UUID REFERENCES projects(project_id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_project_skills_project_id ON project_skills(project_id);

CREATE TABLE IF NOT EXISTS project_media (
    media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    media_type VARCHAR(20) NOT NULL CHECK (media_type IN ('link', 'image', 'document')),
    title VARCHAR(255) NOT NULL,
    url TEXT,
    file_url TEXT,
    file_name VARCHAR(255),
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_media_project_id ON project_media(project_id);
