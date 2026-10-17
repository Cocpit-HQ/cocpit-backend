# Final End-to-End Implementation Plan: Hybrid AI ATS (v3)

> Branch: `feature/jdMatching`. Every file reference is verified against the actual codebase.

---

## Core Philosophy

Treat Gemini as an expensive expert consultant.

* You don't call the consultant for every application that arrives.
* You do a quick internal screen first (free backend score).
* You call the consultant only for candidates that actually need their expertise.
* If the recruiter pulls out a specific application, you call on-demand.

---

## Scoring & Queue Strategy (Three Tiers)

When a candidate applies, the backend score is calculated immediately for free. Based on that score, the application is placed into one of three tiers:

```
Backend Score Calculated (free, milliseconds)
           │
           ├─── Score ≥ 65  OR  top 15 for this job?
           │         └──► 🟢 TIER 1: Queue immediately (HIGH priority)
           │
           ├─── Score 30–64?
           │         └──► 🟡 TIER 2: Queue with LOW priority (idle-time processing)
           │
           └─── Score < 30?
                     └──► 🔴 TIER 3: Not queued. Gemini only if recruiter opens.
```

**Why a relative check ("top 15 for this job") AND an absolute threshold?**
A fixed absolute threshold (e.g., >= 65) doesn't account for job-specific difficulty. If a JD has 8 required skills and a candidate matches 5, they score 62.5% — below the absolute threshold — but they may be the best candidate this job receives. The "top 15" check ensures the queue always contains the best candidates regardless of their absolute score.

**Why three tiers instead of two?**
The "deferred" tier (30–64) costs nothing to queue. The worker drains it at night when the system is idle. If the recruiter never looks at those candidates, you never pay. The "skip" tier (< 30) represents spam and clearly unqualified applications — you never analyze them unless a recruiter specifically requests it.

---

## The "Late Great Applicant" Problem — Solved

The scenario: 10 weak candidates apply Monday, get analyzed, cost money. 20 strong candidates apply Wednesday — but by now you've already burned budget on the weak ones.

**Solution: Dynamic queue re-evaluation on every new application.**

When a new application arrives and it ranks in the top 15, we check if any existing PENDING Tier 1 jobs have been displaced by the new application's higher score:
```
New applicant ranks #12 (top 15) → Queued as Tier 1
Existing applicant drops to rank #16 → Demoted to Tier 2 (if still PENDING)
```
This is a single UPDATE query and adds negligible overhead at apply time.

---

## Phase 0: Database Migrations

### Migration A — Extend `job_applications`
```sql
-- NEW: migrations/20260627_003_frozen_filters.sql
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS frozen_experience_years SMALLINT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frozen_location         TEXT,
  ADD COLUMN IF NOT EXISTS frozen_highest_degree   TEXT,
  ADD COLUMN IF NOT EXISTS frozen_skills           TEXT[],
  ADD COLUMN IF NOT EXISTS backend_score           SMALLINT  DEFAULT 0;
  -- backend_score stored here for fast ranking before AI analysis exists

CREATE INDEX IF NOT EXISTS idx_ja_job_backend_score
  ON job_applications(job_id, backend_score DESC);
CREATE INDEX IF NOT EXISTS idx_ja_job_exp
  ON job_applications(job_id, frozen_experience_years DESC);
CREATE INDEX IF NOT EXISTS idx_ja_skills_gin
  ON job_applications USING GIN (frozen_skills);
```

### Migration B — `application_snapshots` (Immutable Vault)
```sql
-- NEW: migrations/20260627_004_application_snapshots.sql
CREATE TABLE IF NOT EXISTS application_snapshots (
  application_id    UUID PRIMARY KEY
                    REFERENCES job_applications(application_id) ON DELETE CASCADE,
  candidate_snapshot JSONB NOT NULL,
  job_snapshot       JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Migration C — `ai_analysis_queue` (Three-Tier Queue)
```sql
-- NEW: migrations/20260627_005_ai_analysis_queue.sql
CREATE TABLE IF NOT EXISTS ai_analysis_queue (
  queue_id        UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID     NOT NULL
                           REFERENCES job_applications(application_id) ON DELETE CASCADE,
  status          TEXT     NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  priority        SMALLINT NOT NULL DEFAULT 1,
  -- Priority values:
  --   3 = Recruiter on-demand (highest)
  --   2 = Tier 1 auto (score >= 65 or top 15)
  --   1 = Tier 2 deferred (score 30-64, processed during idle time)
  reason          TEXT     NOT NULL DEFAULT 'TIER1_AUTO',
  retry_count     SMALLINT NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_queue_pending
  ON ai_analysis_queue(priority DESC, created_at ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_ai_queue_application
  ON ai_analysis_queue(application_id);
```

### Migration D — Extend `application_ai_analyses`
```sql
-- NEW: migrations/20260627_006_extend_ai_analyses.sql
ALTER TABLE application_ai_analyses
  ADD COLUMN IF NOT EXISTS analysis_type  TEXT NOT NULL DEFAULT 'BACKEND'
                                          CHECK (analysis_type IN ('BACKEND','GEMINI')),
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS latency_ms     INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_in      INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_out     INTEGER;
```

### Migration E — `ai_extracted_requirements` on `jobs`
```sql
-- NEW: migrations/20260627_007_job_ai_requirements.sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS ai_extracted_requirements JSONB;
-- e.g. { "skills": ["React", "Node.js"], "experience_min": 3, "education": "B.Tech" }
```

---

## Phase 1: "Extract Once" — Job Creation

**File:** `src/prompts/jd-generator.v1.js`

Add `required_skills_keywords` to the JSON schema output — a clean keyword array (not sentences) used only for backend scoring and the job snapshot.

```javascript
// Add to JD_JSON_SCHEMA.properties:
required_skills_keywords: {
  type: 'array',
  items: { type: 'string' },
  description: "4-8 required skill keywords. Short terms only: ['React', 'Node.js']. No sentences.",
},
```

**File:** `src/modules/jobs/job.controller.js` (inside `generateJD`, after the jobs UPDATE)

```javascript
// After saving description to jobs table:
const aiRequirements = {
  skills: generated.required_skills_keywords || [],
  experience_min: generated.experience_min || null,
  education: generated.education || null,
};
await client.query(
  `UPDATE jobs SET ai_extracted_requirements = $1 WHERE job_id = $2`,
  [JSON.stringify(aiRequirements), id]
);
```

---

## Phase 2: The Apply Flow (The Critical Path)

**File:** `src/modules/jobs/job.controller.js` — `applyJob` handler (lines 651–786)

### Step-by-step inside the transaction

```javascript
// 1. pool.connect() + BEGIN

// 2. Existing validations (no change): duplicate check, org check, resume handling

// 3. Fetch live profile data (INSIDE the transaction — data is frozen at this instant)
const [skillsRes, expRes, eduRes, jobRes] = await Promise.all([
  client.query(`
    SELECT s.name FROM user_skills us
    JOIN skills s ON us.skill_id = s.skill_id
    JOIN profiles p ON us.profile_id = p.profile_id
    WHERE p.user_id = $1`, [userId]),
  client.query(`
    SELECT title, company_name, start_date, end_date, is_current
    FROM experiences e JOIN profiles p ON e.profile_id = p.profile_id
    WHERE p.user_id = $1 ORDER BY start_date DESC`, [userId]),
  client.query(`
    SELECT degree, school_name, end_date FROM educations ed
    JOIN profiles p ON ed.profile_id = p.profile_id
    WHERE p.user_id = $1 ORDER BY end_date DESC LIMIT 2`, [userId]),
  client.query(`
    SELECT title, description, experience_min, experience_max,
           experience_label, location, ai_extracted_requirements
    FROM jobs WHERE job_id = $1`, [id]),
]);

const job = jobRes.rows[0];
const candidateSkills = skillsRes.rows.map(r => r.name);
const experienceRows = expRes.rows;
const educationRows = eduRes.rows;

// 4. Calculate scalars
const totalYears = calculateTotalExperienceYears(experienceRows); // simple date math
const highestDegree = educationRows[0]?.degree || null;
const candidateLocation = req.body.location || userLocation;

// 5. Calculate backend score (pure JS, $0 cost)
//    Reuses existing compareExperience from application.utils.js
const backendScore = calculateBackendScore({
  candidateSkills,
  totalYears,
  jobRequirements: job.ai_extracted_requirements,
  experienceMin: job.experience_min,
  experienceMax: job.experience_max,
  experienceLabel: job.experience_label,
});
// Returns 0–100 integer. No Gemini.

// 6. INSERT job_applications (existing + new frozen fields)
appResult = await client.query(`
  INSERT INTO job_applications
    (job_id, applicant_id, full_name, email, phone, resume_url, cover_note,
     frozen_experience_years, frozen_location, frozen_skills, frozen_highest_degree, backend_score)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  RETURNING application_id`,
  [...existingFields, totalYears, candidateLocation, candidateSkills, highestDegree, backendScore]
);
const appId = appResult.rows[0].application_id;

// 7. Build and store frozen snapshots
const candidateSnapshot = {
  skills: candidateSkills,
  experience: experienceRows,
  education: educationRows,
  totalExperienceYears: totalYears,
  location: candidateLocation,
  highestDegree,
  resumeUrl: resume_url,
};
const jobSnapshot = {
  title: job.title,
  experienceMin: job.experience_min,
  experienceMax: job.experience_max,
  skills: job.ai_extracted_requirements?.skills || [],
  education: job.ai_extracted_requirements?.education,
};
await client.query(`
  INSERT INTO application_snapshots (application_id, candidate_snapshot, job_snapshot)
  VALUES ($1, $2, $3)`,
  [appId, JSON.stringify(candidateSnapshot), JSON.stringify(jobSnapshot)]
);

// 8. INSERT backend score into application_ai_analyses immediately
//    This ensures the recruiter dashboard always has SOMETHING to sort by.
await client.query(`
  INSERT INTO application_ai_analyses (application_id, match_score, analysis_type, provider)
  VALUES ($1, $2, 'BACKEND', 'backend')`,
  [appId, backendScore]
);

// 9. Determine tier and queue accordingly
//
// ── Minimum Pool Gate ────────────────────────────────────────────────────────
// If this job has fewer than MIN_APPLICATIONS_FOR_AUTO_ANALYSIS total
// applications, skip ALL automatic Gemini queueing.
// The recruiter can still trigger analysis manually via POST /analyze.
// This prevents wasting budget on jobs that barely have any applicants.
const MIN_POOL = parseInt(process.env.AI_MIN_APPLICATIONS_FOR_AUTO || '25', 10);

const totalAppsRes = await client.query(
  `SELECT COUNT(*) AS total FROM job_applications WHERE job_id = $1`,
  [id]
);
const totalApplications = parseInt(totalAppsRes.rows[0].total, 10);
// Note: this count already includes the row we just inserted above.

if (totalApplications < MIN_POOL) {
  // ⏸️ NOT ENOUGH APPLICATIONS YET — skip all auto-queueing.
  // Score is still saved as a BACKEND analysis so the dashboard can sort.
  // Recruiter can use POST /applications/:id/analyze to trigger manually.
  console.log(`[applyJob] Job ${id} has ${totalApplications}/${MIN_POOL} apps — skipping auto-queue.`);

} else {
  // Pool is large enough — apply the three-tier scoring strategy.

  const rankRes = await client.query(`
    SELECT COUNT(*) + 1 AS rank
    FROM job_applications
    WHERE job_id = $1 AND backend_score > $2`,
    [id, backendScore]
  );
  const rank = parseInt(rankRes.rows[0].rank, 10);

  const TIER1_THRESHOLD = parseInt(process.env.AI_TIER1_SCORE_THRESHOLD || '65', 10);
  const TIER1_TOP_N     = parseInt(process.env.AI_TIER1_TOP_N || '15', 10);
  const TIER2_THRESHOLD = parseInt(process.env.AI_TIER2_SCORE_THRESHOLD || '30', 10);

  if (backendScore >= TIER1_THRESHOLD || rank <= TIER1_TOP_N) {
    // 🟢 TIER 1: Queue immediately with high priority
    await client.query(`
      INSERT INTO ai_analysis_queue (application_id, priority, reason)
      VALUES ($1, 2, 'TIER1_AUTO')`,
      [appId]
    );

    // Demotion: if a previous Tier 1 candidate is now displaced from top 15,
    // downgrade them to Tier 2 (only if still PENDING — not yet processed)
    await client.query(`
      UPDATE ai_analysis_queue aq
      SET priority = 1, reason = 'TIER2_DEMOTED'
      WHERE aq.priority = 2
        AND aq.status = 'PENDING'
        AND aq.application_id IN (
          SELECT ja.application_id
          FROM job_applications ja
          WHERE ja.job_id = $1
            AND ja.backend_score < $2
            AND ja.application_id != $3
          ORDER BY ja.backend_score DESC
          OFFSET $4
        )`,
      [id, backendScore, appId, TIER1_TOP_N]
    );

  } else if (backendScore >= TIER2_THRESHOLD) {
    // 🟡 TIER 2: Queue with low priority (idle-time processing)
    await client.query(`
      INSERT INTO ai_analysis_queue (application_id, priority, reason)
      VALUES ($1, 1, 'TIER2_DEFERRED')`,
      [appId]
    );
    // No Gemini call now. Worker will drain this during off-peak hours.
  }
  // 🔴 TIER 3 (score < 30): Not queued. Application is saved. Score = backend_score.
}

// 10. Existing status history log (no change)
await client.query(
  `INSERT INTO application_status_history (application_id, status) VALUES ($1, 'Applied')`,
  [appId]
);

// 11. COMMIT and return — candidate never waits for Gemini
await client.query('COMMIT');
res.status(201).json({ message: 'Application submitted successfully', applicationId: appId });
```

### New helper: `calculateBackendScore` in `application.utils.js`

Add to the existing `src/modules/jobs/applications/application.utils.js`:

```javascript
// ADD to application.utils.js
const calculateBackendScore = ({ candidateSkills, totalYears, jobRequirements, experienceMin, experienceMax, experienceLabel }) => {
  // 1. Skills match (60% weight)
  const jobSkills = (jobRequirements?.skills || []).map(s => s.toLowerCase());
  const normCandidateSkills = (candidateSkills || []).map(s => s.toLowerCase());
  const matchedCount = normCandidateSkills.filter(s => jobSkills.includes(s)).length;
  const skillScore = jobSkills.length > 0
    ? Math.round((matchedCount / jobSkills.length) * 100)
    : 50; // No requirements defined — neutral score

  // 2. Experience match (40% weight) — reuse existing compareExperience
  const expResult = compareExperience(totalYears, experienceMin, experienceMax, experienceLabel);
  const expScore = expResult.status === 'MATCHES' ? 100
                 : expResult.status === 'EXCEEDS' ? 90
                 : expResult.status === 'BELOW'   ? 30
                 : 50;

  return Math.min(100, Math.round((skillScore * 0.6) + (expScore * 0.4)));
};

module.exports = { compareExperience, getLatestEducation, calculateBackendScore };
```

---

## Phase 3: The Background Worker

### `src/workers/applicationAnalysisWorker.js` (NEW)

The worker has one key behavioral rule: **Tier 2 jobs are only processed if there are no Tier 1 jobs waiting.**

```javascript
const processAnalysisQueue = async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Fetch jobs ordered by priority DESC — Tier 1 (priority=2) drains before Tier 2 (priority=1)
    // Priority 3 = recruiter on-demand (highest)
    const pending = await client.query(`
      SELECT queue_id, application_id, priority, retry_count
      FROM ai_analysis_queue
      WHERE status = 'PENDING'
      ORDER BY priority DESC, created_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
    `);

    if (pending.rowCount === 0) {
      await client.query('COMMIT');
      return; // Nothing to do
    }

    for (const job of pending.rows) {
      try {
        await client.query(
          `UPDATE ai_analysis_queue SET status = 'PROCESSING' WHERE queue_id = $1`,
          [job.queue_id]
        );
        await client.query('SAVEPOINT before_analysis');

        await analyzeApplication(client, job.application_id);

        await client.query(
          `UPDATE ai_analysis_queue SET status = 'COMPLETED' WHERE queue_id = $1`,
          [job.queue_id]
        );
        console.log(`[AnalysisWorker] Completed app ${job.application_id} (priority ${job.priority})`);

      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT before_analysis');
        const retries = (job.retry_count || 0) + 1;
        if (retries >= 3) {
          await client.query(
            `UPDATE ai_analysis_queue SET status = 'FAILED', error_message = $1 WHERE queue_id = $2`,
            [err.message, job.queue_id]
          );
        } else {
          await client.query(
            `UPDATE ai_analysis_queue SET retry_count = $1, status = 'PENDING' WHERE queue_id = $2`,
            [retries, job.queue_id]
          );
        }
        console.error(`[AnalysisWorker] Failed app ${job.application_id}:`, err.message);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[AnalysisWorker] FATAL:', err);
  } finally {
    if (client) client.release();
  }
};
```

### `src/services/candidateAnalysis.service.js` (NEW)

```javascript
const analyzeApplication = async (client, applicationId) => {
  const startTime = Date.now();

  // Reads ONLY from frozen vault — never touches live users or jobs tables
  const snap = await client.query(
    `SELECT candidate_snapshot, job_snapshot FROM application_snapshots WHERE application_id = $1`,
    [applicationId]
  );
  if (snap.rowCount === 0) throw new Error(`Snapshot missing for application ${applicationId}`);

  const { candidate_snapshot, job_snapshot } = snap.rows[0];
  const promptText = buildAnalysisPrompt(candidate_snapshot, job_snapshot);
  const model = process.env.AI_MODEL || 'gemini-2.5-flash';

  const result = await withRetry(() =>
    withTimeout(genAI.models.generateContent({ model, contents: [...], config: { ... } }), 15_000)
  );

  const parsed = JSON.parse(typeof result.text === 'function' ? result.text() : result.text);

  // UPDATE (not INSERT) — replaces the backend score row with the rich AI result
  await client.query(`
    UPDATE application_ai_analyses
    SET match_score    = $1,
        summary        = $2,
        skills         = $3,
        experience     = $4,
        qualification  = $5,
        analysis_type  = 'GEMINI',
        model          = $6,
        prompt_version = 'v1.0',
        latency_ms     = $7,
        tokens_in      = $8,
        tokens_out     = $9,
        created_at     = NOW()
    WHERE application_id = $10`,
    [parsed.match_score, JSON.stringify({strengths: parsed.strengths, concerns: parsed.concerns, recommendation: parsed.recommendation}),
     JSON.stringify(parsed.skills), JSON.stringify(parsed.experience), JSON.stringify(parsed.qualification),
     model, Date.now() - startTime,
     result.usageMetadata?.promptTokenCount || 0,
     result.usageMetadata?.candidatesTokenCount || 0,
     applicationId]
  );
};
```

### `src/core/ai/helpers.js` (NEW)
Extracts `withTimeout`, `withRetry`, `sleep`, `isRetryable` from `ai.service.js` into a shared module. `ai.service.js` imports from here — no behavior change for JD generation.

---

## Phase 4: Recruiter Read Path

### `application.queries.js` — Update `getApplicantList`

```javascript
// MODIFY: getApplicantList
// 1. Add dynamic filter params (experience, skills, location, status)
// 2. Change ORDER BY to: match_score DESC NULLS LAST, applied_at DESC
// 3. Add analysis_type to SELECT (so frontend can show badge)

ORDER BY aaa.match_score DESC NULLS LAST, ja.applied_at DESC
```

The dashboard always sorts by `match_score`. For Tier 1 candidates, this is the rich Gemini score. For Tier 2/3 candidates, it's the backend score (clearly labelled with `analysisType: 'BACKEND'`).

### `application.controller.js` — Simplify `getAnalysis`

Remove the 3 secondary DB queries (lines 300–328). The `experience` and `qualification` fields are now stored in the analysis row. Return the stored data directly.

### `application.controller.js` — Implement `triggerAnalysis` (On-Demand)

When the recruiter opens a Tier 2 or Tier 3 candidate:

```javascript
// MODIFY: exports.triggerAnalysis
exports.triggerAnalysis = async (req, res) => {
  // 1. Auth: assertRecruiterAccess
  // 2. Check if already in queue (PENDING or PROCESSING)
  // 3. If not: INSERT with priority = 3 (highest — recruiter is waiting)
  //    reason = 'ON_DEMAND_RECRUITER'
  // 4. Return 202 Accepted
  // Frontend polls GET /analysis every 3s until analysisType = 'GEMINI'
  res.status(202).json({ message: 'Analysis queued', status: 'PENDING' });
};
```

---

## Phase 5: Bootstrap the Worker

**File:** `src/server.js`
```javascript
const { processAnalysisQueue } = require('./workers/applicationAnalysisWorker');
setInterval(processAnalysisQueue, Number(process.env.AI_ANALYSIS_INTERVAL_MS) || 30_000);
```

---

## What the Recruiter Sees

```
Applicants for: Senior UI/UX Designer

Name            Score    Badge
──────────────────────────────────
Priya Sharma    94%      ✨ AI Analyzed
Rahul M.        91%      ✨ AI Analyzed
James K.        88%      ✨ AI Analyzed
Sneha R.        79%      ✨ AI Analyzed
Amit T.         65%      ~ Estimated
Karan D.        58%      ~ Estimated
Anjali P.       22%      ~ Estimated
```

* `✨ AI Analyzed` = `analysis_type: 'GEMINI'`
* `~ Estimated` = `analysis_type: 'BACKEND'` (free score, still sortable)
* Recruiter clicks Karan (58%) → `triggerAnalysis` fires → 202 → frontend polls → badge becomes `✨` within 10 seconds

---

## Cost Analysis (500 applicants example)

| Approach | Gemini Calls | Estimated Cost |
|---|---|---|
| Analyze everyone immediately | 500 | $$$$$ |
| Previous "Top 20" plan | ~20 | $$ |
| **This plan (threshold-based)** | ~80–120 (Top 15 + score >= 65) | **$ (80% cheaper)** |
| On-demand only | Varies | Unpredictable |

---

## Environment Variables (Configurable without code changes)

```env
AI_MIN_APPLICATIONS_FOR_AUTO=25  # Minimum applications before any auto-Gemini runs
AI_TIER1_SCORE_THRESHOLD=65      # Score >= this → Tier 1 (immediate Gemini)
AI_TIER1_TOP_N=15                # Always analyze top N regardless of score
AI_TIER2_SCORE_THRESHOLD=30      # Score >= this → Tier 2 (deferred, idle-time)
AI_ANALYSIS_INTERVAL_MS=30000    # Worker poll interval
AI_MODEL=gemini-2.5-flash
```

---

## New & Modified Files

| Status | File |
|--------|------|
| **NEW** | `migrations/20260627_003_frozen_filters.sql` |
| **NEW** | `migrations/20260627_004_application_snapshots.sql` |
| **NEW** | `migrations/20260627_005_ai_analysis_queue.sql` |
| **NEW** | `migrations/20260627_006_extend_ai_analyses.sql` |
| **NEW** | `migrations/20260627_007_job_ai_requirements.sql` |
| **NEW** | `src/core/ai/helpers.js` |
| **NEW** | `src/prompts/applicant-evaluator.v1.js` |
| **NEW** | `src/services/candidateAnalysis.service.js` |
| **NEW** | `src/workers/applicationAnalysisWorker.js` |
| **MODIFY** | `src/prompts/jd-generator.v1.js` — add `required_skills_keywords` |
| **MODIFY** | `src/modules/jobs/job.controller.js` — `applyJob` (transaction + snapshot + tiered queue); `generateJD` (save requirements) |
| **MODIFY** | `src/modules/jobs/applications/application.utils.js` — add `calculateBackendScore` |
| **MODIFY** | `src/modules/jobs/applications/application.queries.js` — `getApplicantList` filters + sort |
| **MODIFY** | `src/modules/jobs/applications/application.controller.js` — `getAnalysis` (simplify), `triggerAnalysis` (implement), `getApplicantList` (pass filters) |
| **MODIFY** | `src/services/ai.service.js` — import from `core/ai/helpers.js` |
| **MODIFY** | `src/server.js` — register analysis worker |
