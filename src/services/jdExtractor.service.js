"use strict";

const genAI = require("../config/gemini");
const { SYSTEM_INSTRUCTION, JD_EXTRACTOR_SCHEMA, buildExtractorPrompt } = require("../prompts/jd-extractor.v1");
const { withTimeout, withRetry } = require("../core/ai/helpers");

const TIMEOUT_MS = 10000; // Fast extraction timeout

/**
 * Extracts skills, minimum experience, and education from a job description text using Gemini.
 *
 * @param {string} description - The job description text.
 * @returns {Promise<object>} The extracted requirements object.
 */
const extractRequirementsFromJDText = async (description) => {
  if (!description || typeof description !== "string" || description.trim().length < 10) {
    return { skills: [], experience_min: null, education: null };
  }

  const modelStr = process.env.AI_MODEL || "gemini-2.5-flash";
  const promptText = buildExtractorPrompt(description);

  const callGemini = async () => {
    const geminiCall = genAI.models.generateContent({
      model: modelStr,
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: JD_EXTRACTOR_SCHEMA,
        temperature: 0.1,
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
      throw new Error("Extractor returned empty response");
    }

    return JSON.parse(text);
  };

  try {
    return await withRetry(callGemini);
  } catch (err) {
    console.error("[JD Extractor] Failed to extract requirements from JD text:", err.message);
    return { skills: [], experience_min: null, education: null };
  }
};

module.exports = {
  extractRequirementsFromJDText
};
