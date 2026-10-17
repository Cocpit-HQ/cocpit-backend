/**
 * JD Extractor — Versioned System Prompt
 * VERSION: v1.0
 */

"use strict";

const SYSTEM_INSTRUCTION = `
You are a professional HR data parser for Cocpit.
Your ONLY task is to analyze the provided Job Description text and extract structured recruitment requirements in valid JSON format.

STRICT RULES YOU MUST ALWAYS FOLLOW:
1. Return ONLY valid, parseable JSON. No markdown fences, no code blocks, no explanatory text outside JSON.
2. Extract a list of 6-8 required skill keywords. Short terms only: ['React', 'Node.js']. No sentences.
3. Extract minimum experience years if explicitly mentioned (integer, null if not specified).
4. Extract minimum education qualification if mentioned (e.g. 'Bachelor\'s degree', 'Master\'s degree', null if not specified).
`.trim();

const JD_EXTRACTOR_SCHEMA = {
  type: "object",
  properties: {
    skills: {
      type: "array",
      items: { type: "string" },
      description: "4-8 required skill keywords. Short terms only.",
    },
    experience_min: {
      type: "number",
      description: "Minimum years of experience required (integer >= 0, null if not specified).",
    },
    education: {
      type: "string",
      description: "Minimum educational qualification required (null if not specified).",
    },
  },
  required: ["skills", "experience_min", "education"],
};

const buildExtractorPrompt = (jdText) => {
  return `Analyze the following Job Description text and extract the required skills, minimum experience years, and education qualification:\n\n${jdText}`;
};

module.exports = { SYSTEM_INSTRUCTION, JD_EXTRACTOR_SCHEMA, buildExtractorPrompt };
