-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260624_002_application_notes_and_ai_analyses
--
-- Adds two tables to support the Applicants page:
--   1. application_notes       — recruiter self-notes per application
--   2. application_ai_analyses — AI evaluation results (contract table)
--
-- Safe to run multiple times (uses IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Recruiter self-notes per application ───────────────────────────────────
CREATE TABLE IF NOT EXISTS application_notes (
  note_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(application_id) ON DELETE CASCADE,
  author_id      UUID NOT NULL REFERENCES users(user_id)        ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(application_id, author_id)     -- one self-note per recruiter per application
);

CREATE INDEX IF NOT EXISTS idx_application_notes_app_id
  ON application_notes(application_id);

-- ── 2. AI analysis results (contract table — written by AI engineer) ──────────
CREATE TABLE IF NOT EXISTS application_ai_analyses (
  analysis_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(application_id) ON DELETE CASCADE,
  match_score    INTEGER CHECK (match_score >= 0 AND match_score <= 100),
  summary        JSONB,
  -- { strengths: string[], concerns: string[], recommendation: string }
  skills         JSONB,
  -- { match: number, tags: [{name: string, matched: boolean}], summary: string }
  experience     JSONB,
  -- { status: "EXCEEDS"|"ALIGNED"|"BELOW", required: string, actual: string, summary: string }
  qualification  JSONB,
  -- { status: "ALIGNED"|"OVERQUALIFIED"|"BELOW", degree: string, class: string, summary: string }
  provider       TEXT DEFAULT 'gemini',
  model          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_analyses_app_id
  ON application_ai_analyses(application_id);
