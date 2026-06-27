# Phase 1: Job-Level Skill Extraction (Extract Once)

## Objective
Reduce AI input tokens by extracting structured keyword skills and core requirements at the time of Job Description generation.

## Implementation Steps
1. Modify `src/prompts/jd-generator.v1.js`:
   - Update `JD_JSON_SCHEMA.properties` to include `required_skills_keywords`:
     - Type: `array` of `string`
     - Description: "4-8 required skill keywords. Short terms only: ['React', 'Node.js']. No sentences."
2. Modify `src/modules/jobs/job.controller.js` (`generateJD`):
   - After the JD generation succeeds and the primary job `UPDATE` runs, extract the new requirements.
   - Run a subsequent `UPDATE` query:
     ```sql
     UPDATE jobs SET ai_extracted_requirements = $1 WHERE job_id = $2
     ```
   - Store an object like `{ skills: [], experience_min: number, education: string }`.

## Automation Testing Instructions
- Create a test script `scratch/test_phase1.js` that calls the `generateJD` controller logic (or directly calls the AI service) and verifies that `ai_extracted_requirements` is successfully populated on the job row.
- Run `npm test` to ensure no existing JD generation functionality is broken.
