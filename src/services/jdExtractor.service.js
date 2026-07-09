"use strict";

const genAI = require("../config/gemini");
const pool = require("../core/db/pool");
const { SYSTEM_INSTRUCTION, JD_EXTRACTOR_SCHEMA, buildExtractorPrompt } = require("../prompts/jd-extractor.v1");
const { withTimeout, withRetry } = require("../core/ai/helpers");

const TIMEOUT_MS = 10000; // Fast extraction timeout

/**
 * Extracts skills, minimum experience, and education from a job description text using Gemini.
 *
 * @param {string} description - The job description text.
 * @returns {Promise<object>} The extracted requirements object.
 */
const extractRequirementsFromJDText = async (description, jobId = null, userId = null, orgId = null, sourceIp = null) => {
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

    return {
      data: JSON.parse(text),
      usageMetadata: result.usageMetadata || {},
    };
  };

  let geminiError = null;
  let usage = {};
  let latencyMs = 0;
  let parsedData = { skills: [], experience_min: null, education: null };
  const startTime = Date.now();

  try {
    const attemptResult = await withRetry(callGemini);
    latencyMs = Date.now() - startTime;
    usage = attemptResult.usageMetadata || {};
    parsedData = attemptResult.data;
  } catch (err) {
    latencyMs = Date.now() - startTime;
    console.error("[JD Extractor] Failed to extract requirements from JD text:", err.message);
    geminiError = err;
  }

  // Write Telemetry
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || (tokensIn + tokensOut);
  const costEstimate = parseFloat(((tokensIn * 0.00000015) + (tokensOut * 0.0000006)).toFixed(8));

  pool.query(`
    INSERT INTO ai_usage_log (
      user_id, org_id, feature, related_entity_id, model,
      prompt_tokens, completion_tokens, total_tokens, cost_estimate_usd,
      latency_ms, cache_hit, success, error_message, source_ip
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    userId || null, orgId || null, 'jd_extract', jobId || null, modelStr,
    tokensIn, tokensOut, totalTokens, costEstimate,
    latencyMs, false, !geminiError, geminiError ? geminiError.message : null, sourceIp || null
  ]).catch(err => {
    console.error("[AI Telemetry] Failed to write to ai_usage_log:", err.message);
  });

  return parsedData;
};

module.exports = {
  extractRequirementsFromJDText
};
