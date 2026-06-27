"use strict";

const SYSTEM_INSTRUCTION = `
You are an expert technical recruiter and AI assistant for the Cocpit platform.
Your task is to analyze a candidate's profile against a specific Job Description and provide a structured, objective, and unbiased evaluation.

STRICT RULES YOU MUST ALWAYS FOLLOW:
1. Return ONLY valid, parseable JSON. No markdown fences, no code blocks.
2. Base your evaluation strictly on the provided candidate data and job requirements.
3. Be objective. Do not make assumptions about the candidate's background beyond what is provided.
4. Provide a match score from 0 to 100 representing how well the candidate fits the role.
5. Provide actionable insights in the strengths and weaknesses arrays.
6. The JSON you return must exactly match the schema provided.
7. For skills.tags, list ALL required job skills and mark each as matched (true) if the candidate has it, false if they don't.
`.trim();

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    match_score: {
      type: "number",
      description: "Overall match score from 0 to 100.",
    },
    summary: {
      type: "string",
      description: "A 2-3 sentence summary of the candidate's fit for the role.",
    },
    strengths: {
      type: "array",
      items: { type: "string" },
      description: "2-3 key strengths or matching qualifications.",
    },
    weaknesses: {
      type: "array",
      items: { type: "string" },
      description: "1-3 missing skills, gaps, or areas of concern.",
    },
    recommendation: {
      type: "string",
      description: "One of: 'Strong Hire', 'Hire', 'Borderline', 'No Hire'.",
    },
    skills: {
      type: "object",
      description: "Skills comparison between job requirements and candidate.",
      properties: {
        match: {
          type: "number",
          description: "Percentage of required skills the candidate has (0-100).",
        },
        tags: {
          type: "array",
          description: "Each required job skill with a boolean indicating if the candidate has it.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Skill name." },
              matched: { type: "boolean", description: "True if candidate has this skill." },
            },
            required: ["name", "matched"],
          },
        },
        summary: {
          type: "string",
          description: "One sentence summarising the skills match, e.g. 'Has 4 of 5 required skills.'",
        },
      },
      required: ["match", "tags", "summary"],
    },
  },
  required: ["match_score", "summary", "strengths", "weaknesses", "recommendation", "skills"],
};

const buildAnalysisPrompt = (candidateSnapshot, jobSnapshot) => {
  return `
Analyze this candidate for the following job role.

--- JOB REQUIREMENTS ---
Title: ${jobSnapshot.title || "Unknown Role"}
Experience Required: ${jobSnapshot.experienceMin || 0} to ${jobSnapshot.experienceMax || "Any"} years
Required Skills: ${(jobSnapshot.skills || []).join(", ")}
Education: ${jobSnapshot.education || "Not specified"}

--- CANDIDATE PROFILE ---
Total Experience: ${candidateSnapshot.totalExperienceYears} years
Highest Degree: ${candidateSnapshot.highestDegree || "Not specified"}
Candidate Skills: ${(candidateSnapshot.skills || []).join(", ")}

Work Experience:
${(candidateSnapshot.experience || []).map(e => `- ${e.title} at ${e.company_name} (from ${e.start_date || "?"} to ${e.is_current ? "Present" : (e.end_date || "?")})`).join("\n")}

Education:
${(candidateSnapshot.education || []).map(e => `- ${e.degree} from ${e.school_name}`).join("\n")}

Return the structured JSON evaluation including the detailed skills, experience, and qualification breakdowns.
  `.trim();
};

module.exports = {
  SYSTEM_INSTRUCTION,
  ANALYSIS_SCHEMA,
  buildAnalysisPrompt
};
