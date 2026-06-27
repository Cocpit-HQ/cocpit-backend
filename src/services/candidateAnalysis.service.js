"use strict";

const genAI = require("../config/gemini");
const pool = require("../core/db/pool");
const { withTimeout, withRetry, TIMEOUT_MS = 15000 } = require("../core/ai/helpers");
const { SYSTEM_INSTRUCTION, ANALYSIS_SCHEMA, buildAnalysisPrompt } = require("../prompts/applicant-evaluator.v1");
const {
  calculateTotalExperienceYears,
  compareExperience,
  getLatestEducation,
} = require("../modules/jobs/applications/application.utils");

/**
 * Analyzes a candidate against a job based exclusively on stored snapshots.
 *
 * @param {string} applicationId - UUID of the job application
 * @returns {Promise<object>} The Gemini analysis result
 */
const analyzeCandidate = async (applicationId) => {
  const modelStr = process.env.AI_EVALUATOR_MODEL || "gemini-2.5-flash";

  // 1. Fetch frozen snapshots from DB
  const snapRes = await pool.query(
    `SELECT candidate_snapshot, job_snapshot FROM application_snapshots WHERE application_id = $1`,
    [applicationId]
  );

  if (snapRes.rowCount === 0) {
    throw new Error(`No snapshots found for application ${applicationId}`);
  }

  const { candidate_snapshot, job_snapshot } = snapRes.rows[0];

  // 2. Resolve experience fields — use snapshot values if present,
  //    otherwise fall back to the live jobs table (handles older snapshots
  //    that were frozen before experienceLabel was added).
  let expMin   = job_snapshot.experienceMin   ?? null;
  let expMax   = job_snapshot.experienceMax   ?? null;
  let expLabel = job_snapshot.experienceLabel ?? null;

  if (expMin === null && expMax === null && !expLabel) {
    // Fetch the application's job_id then read experience fields from jobs table
    const jobIdRes = await pool.query(
      `SELECT j.experience_min, j.experience_max, j.experience_label
       FROM job_applications ja
       JOIN jobs j ON j.job_id = ja.job_id
       WHERE ja.application_id = $1`,
      [applicationId]
    );
    if (jobIdRes.rowCount > 0) {
      expMin   = jobIdRes.rows[0].experience_min   ?? null;
      expMax   = jobIdRes.rows[0].experience_max   ?? null;
      expLabel = jobIdRes.rows[0].experience_label ?? null;
    }
  }

  const totalYears = calculateTotalExperienceYears(candidate_snapshot.experience || []);

  const experienceJson = compareExperience(
    totalYears,
    expMin,
    expMax,
    expLabel
  );
  // Normalise: compareExperience returns 'MATCHES' but the UI design uses 'ALIGNED'
  if (experienceJson.status === 'MATCHES') experienceJson.status = 'ALIGNED';

  const latestEdu = getLatestEducation(candidate_snapshot.education || []);
  // Determine qualification status by comparing candidate degree vs job requirement
  const jobEduReq = job_snapshot.education || null;
  const qualStatus = latestEdu.degree && latestEdu.degree !== 'Not specified'
    ? 'ALIGNED'
    : 'BELOW';
  const qualificationJson = {
    status: jobEduReq ? qualStatus : 'ALIGNED',
    degree: latestEdu.degree || 'Not specified',
    class: latestEdu.class || '',
    summary: latestEdu.summary || 'Candidate education details provided.',
  };

  // 3. Build prompt for Gemini (only AI-specific fields: score, summary, strengths, weaknesses, skills)
  const promptText = buildAnalysisPrompt(candidate_snapshot, job_snapshot);

  let analysisData;
  let usage = { promptTokenCount: 0, candidatesTokenCount: 0 };
  let latencyMs = 0;
  let isFallback = false;

  // 4. Call Gemini with retry & timeout, catch errors to use local fallback
  try {
    const callGemini = async () => {
      const geminiCall = genAI.models.generateContent({
        model: modelStr,
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: ANALYSIS_SCHEMA,
          temperature: 0.2,
        },
      });

      const result = await withTimeout(geminiCall, TIMEOUT_MS);

      const text =
        typeof result.text === "string"
          ? result.text
          : typeof result.text === "function"
          ? result.text()
          : result.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        const err = new Error("Gemini returned an empty response");
        err.statusCode = 502;
        throw err;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const err = new Error("Gemini response is not valid JSON");
        err.statusCode = 502;
        throw err;
      }

      return {
        data: parsed,
        usageMetadata: result.usageMetadata || {},
      };
    };

    const startTime = Date.now();
    const attemptResult = await withRetry(callGemini);
    latencyMs = Date.now() - startTime;

    analysisData = attemptResult.data;
    usage = attemptResult.usageMetadata || usage;
  } catch (err) {
    console.warn(`[AI Worker] Gemini call failed for application_id: ${applicationId}. Using local fallback. Error:`, err.message);
    isFallback = true;
  }

  // 5. Build structured objects to persist
  let summaryJson;
  let skillsJson;
  let finalMatchScore;

  const candidateSkills = candidate_snapshot.skills || [];
  const jobSkills = job_snapshot.skills || [];

  if (isFallback) {
    // Generate deterministic system fallback
    const fallback = generateLocalSystemFallback(candidate_snapshot, job_snapshot, experienceJson, qualificationJson);
    finalMatchScore = fallback.match_score;
    summaryJson = fallback.summary;
    skillsJson = fallback.skills;
  } else {
    // Gemini succeeded, parse results
    finalMatchScore = analysisData.match_score;
    summaryJson = {
      strengths: analysisData.strengths || [],
      concerns: analysisData.weaknesses || [],
      recommendation: analysisData.recommendation || 'Borderline',
      text: analysisData.summary || '',
    };

    // Calculate skills tags deterministically in Javascript to prevent AI hallucinations and keep consistency
    const candidateSkillsLower = candidateSkills.map(s => s.toLowerCase());
    const tags = jobSkills.map(skill => ({
      name: skill,
      matched: candidateSkillsLower.includes(skill.toLowerCase()),
    }));
    const matchedCount = tags.filter(t => t.matched).length;
    skillsJson = {
      match: jobSkills.length > 0 ? Math.round((matchedCount / jobSkills.length) * 100) : 100,
      tags,
      summary: `Has ${matchedCount} of ${jobSkills.length} required skills.`,
    };

    // Post-process skills tags to append extra/irrelevant candidate skills as matched: false (Red chips)
    candidateSkills.forEach(skill => {
      const isRequired = jobSkills.some(js => js.toLowerCase() === skill.toLowerCase());
      if (!isRequired) {
        skillsJson.tags.push({
          name: skill,
          matched: false // Renders in red on the UI
        });
      }
    });
  }

  await pool.query(
    `
    UPDATE application_ai_analyses
    SET 
      match_score    = $1,
      analysis_type  = $2,
      summary        = $3,
      skills         = $4,
      experience     = $5,
      qualification  = $6,
      tokens_in      = $7,
      tokens_out     = $8,
      latency_ms     = $9,
      prompt_version = $10
    WHERE application_id = $11
    `,
    [
      finalMatchScore,
      isFallback ? 'BACKEND' : 'GEMINI',
      JSON.stringify(summaryJson),
      skillsJson ? JSON.stringify(skillsJson) : null,
      JSON.stringify(experienceJson),
      JSON.stringify(qualificationJson),
      usage.promptTokenCount || 0,
      usage.candidatesTokenCount || 0,
      latencyMs,
      isFallback ? 'fallback-v1.0' : 'v1.2',
      applicationId,
    ]
  );

  return {
    match_score: finalMatchScore,
    summary: summaryJson,
    skills: skillsJson,
    experience: experienceJson,
    qualification: qualificationJson
  };
};

/**
 * Deterministic local fallback generator.
 */
const generateLocalSystemFallback = (candidateSnapshot, jobSnapshot, experienceJson, qualificationJson) => {
  const totalYears = calculateTotalExperienceYears(candidateSnapshot.experience || []);
  const jobSkills = jobSnapshot.skills || [];
  const candidateSkills = candidateSnapshot.skills || [];
  const candidateSkillsLower = candidateSkills.map(s => s.toLowerCase());

  const tags = [];
  // 1. Required job skills matching
  jobSkills.forEach(skill => {
    tags.push({
      name: skill,
      matched: candidateSkillsLower.includes(skill.toLowerCase())
    });
  });
  // 2. Extra/irrelevant candidate skills (marked as false to show in red)
  candidateSkills.forEach(skill => {
    const isRequired = jobSkills.some(js => js.toLowerCase() === skill.toLowerCase());
    if (!isRequired) {
      tags.push({
        name: skill,
        matched: false
      });
    }
  });

  const matchedCount = tags.filter(t => t.matched).length;
  const skillsJson = {
    match: jobSkills.length > 0 ? Math.round((matchedCount / jobSkills.length) * 100) : 100,
    tags,
    summary: jobSkills.length > 0 
      ? `Has ${matchedCount} of ${jobSkills.length} required skills.`
      : "No specific skills were required for this role."
  };

  // Calculate local score (60% skills, 40% experience)
  const skillScore = jobSkills.length > 0
    ? Math.round((matchedCount / jobSkills.length) * 100)
    : 50;
  const expScore = experienceJson.status === 'ALIGNED' ? 100
                 : experienceJson.status === 'EXCEEDS' ? 90
                 : experienceJson.status === 'BELOW'   ? 30
                 : 50;
  const localMatchScore = Math.min(100, Math.round((skillScore * 0.6) + (expScore * 0.4)));

  const strengths = [];
  const concerns = [];

  if (experienceJson.status === 'EXCEEDS') {
    strengths.push(`Experience (${totalYears} years) exceeds the job requirements.`);
  } else if (experienceJson.status === 'ALIGNED') {
    strengths.push(`Experience (${totalYears} years) is well-aligned with the role.`);
  } else {
    concerns.push(`Experience (${totalYears} years) is below the required range.`);
  }

  if (jobSkills.length > 0) {
    strengths.push(`Matches ${matchedCount} of ${jobSkills.length} required skills.`);
    const missingSkills = tags.filter(t => !t.matched && jobSkills.some(js => js.toLowerCase() === t.name.toLowerCase()));
    if (missingSkills.length > 0) {
      concerns.push(`Lacks required skills: ${missingSkills.slice(0, 2).map(s => s.name).join(', ')}.`);
    }
  }

  const recommendation = localMatchScore >= 75 ? 'Strong Hire'
                       : localMatchScore >= 60 ? 'Hire'
                       : localMatchScore >= 40 ? 'Borderline'
                       : 'No Hire';

  const summaryJson = {
    strengths: strengths.length > 0 ? strengths : ["Has basic qualifications."],
    concerns: concerns.length > 0 ? concerns : ["No significant concerns identified."],
    recommendation,
    text: `System Match Fallback: The candidate has ${totalYears} years of experience and matches ${matchedCount} required skills. Evaluation is based on profile comparison.`
  };

  return {
    match_score: localMatchScore,
    summary: summaryJson,
    skills: skillsJson
  };
};

module.exports = {
  analyzeCandidate,
  generateLocalSystemFallback,
};
