"use strict";

const genAI = require("../config/gemini");
const pool = require("../core/db/pool");
const sanitizeHtml = require("sanitize-html");
const { SYSTEM_INSTRUCTION } = require("../prompts/content-generator.v1");
const { withTimeout, withRetry } = require("../core/ai/helpers");

const TIMEOUT_MS = 15000;

/**
 * Enforces the daily and monthly AI limits for content generation.
 */
const getAIUsageStats = async (userId, orgId) => {
  if (!userId && !orgId) return { monthlyCount: 0, dailyCount: 0, cycleStart: new Date() };

  let userRes;
  if (orgId) {
    userRes = await pool.query("SELECT created_at FROM organizations WHERE org_id = $1", [orgId]);
  } else {
    userRes = await pool.query("SELECT created_at FROM users WHERE user_id = $1", [userId]);
  }

  if (userRes.rows.length === 0) return { monthlyCount: 0, dailyCount: 0, cycleStart: new Date() };
  const joinDate = new Date(userRes.rows[0].created_at);

  const now = new Date();
  
  let cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), joinDate.getUTCDate()));
  if (now < cycleStart) {
    cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, joinDate.getUTCDate()));
  }

  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  let usageQuery;
  let queryParams;

  if (orgId) {
    usageQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE created_at >= $2) AS monthly_count,
        COUNT(*) FILTER (WHERE created_at >= $3) AS daily_count
      FROM ai_usage_log 
      WHERE org_id = $1 AND feature = 'generate_text' AND success = true
    `;
    queryParams = [orgId, cycleStart.toISOString(), todayStart.toISOString()];
  } else {
    usageQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE created_at >= $2) AS monthly_count,
        COUNT(*) FILTER (WHERE created_at >= $3) AS daily_count
      FROM ai_usage_log 
      WHERE user_id = $1 AND org_id IS NULL AND feature = 'generate_text' AND success = true
    `;
    queryParams = [userId, cycleStart.toISOString(), todayStart.toISOString()];
  }
  
  const usageRes = await pool.query(usageQuery, queryParams);
  const stats = usageRes.rows[0];
  const monthlyCount = parseInt(stats.monthly_count || 0, 10);
  const dailyCount = parseInt(stats.daily_count || 0, 10);

  return { monthlyCount, dailyCount, cycleStart };
};

const enforceAILimits = async (userId, orgId) => {
  if (!userId && !orgId) return;
  const { monthlyCount, dailyCount, cycleStart } = await getAIUsageStats(userId, orgId);

  // Temporarily disabled for testing
  
  if (dailyCount >= 5) {
    const err = new Error("Daily AI limit of 5 requests reached. Try again tomorrow.");
    err.statusCode = 429;
    throw err;
  }
 

  if (monthlyCount >= 45) {
    const nextCycle = new Date(cycleStart);
    nextCycle.setUTCMonth(nextCycle.getUTCMonth() + 1);
    const entity = orgId ? "Organization" : "Monthly";
    const err = new Error(`${entity} AI limit of 45 requests reached. Resets on ${nextCycle.toLocaleDateString()}.`);
    err.statusCode = 429;
    throw err;
  }
};

/**
 * Generates general purpose text (for Enhance with AI).
 * 
 * @param {string} prompt - The user prompt
 * @param {string} tone   - Tone requested (e.g. Friendly, Formal)
 * @param {string} context - The existing editor context to modify/append to
 * @param {string} userId - User ID for telemetry
 * @param {string} sourceIp - IP for telemetry
 * @param {string} orgId - Org ID for telemetry
 * @returns {Promise<string>} The generated plain text
 */
const generateGeneralText = async (prompt, tone, context, userId, sourceIp, orgId) => {
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("A prompt is required.");
  }

  await enforceAILimits(userId, orgId);

  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash";
  const fallbackModel = process.env.AI_FALLBACK_MODEL || "gemini-2.5-pro";
  
  let tailoredPrompt = `[Tone: ${tone}]\nUser Request: ${prompt}`;
  if (context && context.trim().length > 0) {
    tailoredPrompt = `[Tone: ${tone}]\n\nExisting Draft/Context:\n"""\n${context}\n"""\n\nUser Request: Modify or continue the above draft based on this instruction: ${prompt}`;
  }

  const callGemini = async (modelToUse) => {
    const geminiCall = genAI.models.generateContent({
      model: modelToUse,
      contents: [{ role: "user", parts: [{ text: tailoredPrompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "text/plain",
        temperature: 0.7,
      },
    });

    const result = await withTimeout(geminiCall, TIMEOUT_MS);

    let text =
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
    
    // Truncate safely at 1000 chars as per requirements
    if (text.length > 1000) {
      text = text.substring(0, 1000);
    }

    // Sanitize any accidental HTML
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });

    // Validate for forbidden visual/binary elements
    const forbiddenPatterns = [
      /!\[.*?\]\(.*?\)/, // Markdown images
      /<svg\b[^>]*>/i,   // SVG tags
      /```(mermaid|plantuml|graphviz)/i, // Markdown diagrams
      /data:image\/[a-zA-Z]*;base64,/i // Base64 images
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) {
        const err = new Error("Unsupported format generated. Visual assets are not allowed.");
        err.statusCode = 400;
        throw err;
      }
    }

    return {
      text,
      usageMetadata: result.usageMetadata || {},
    };
  };

  let geminiError = null;
  let usage = {};
  let latencyMs = 0;
  let generatedText = "";
  let usedModel = primaryModel;
  const startTime = Date.now();

  try {
    const attemptResult = await withRetry(() => callGemini(primaryModel));
    latencyMs = Date.now() - startTime;
    usage = attemptResult.usageMetadata || {};
    generatedText = attemptResult.text;
  } catch (err) {
    console.error("[Content Generator] Primary model failed:", err.message);
    
    if (fallbackModel && fallbackModel !== primaryModel) {
      try {
        usedModel = fallbackModel;
        console.log(`[Content Generator] Falling back to ${fallbackModel}...`);
        const fallbackResult = await withRetry(() => callGemini(fallbackModel));
        latencyMs = Date.now() - startTime;
        usage = fallbackResult.usageMetadata || {};
        generatedText = fallbackResult.text;
      } catch (fallbackErr) {
        latencyMs = Date.now() - startTime;
        console.error("[Content Generator] Fallback model also failed:", fallbackErr.message);
        geminiError = fallbackErr;
      }
    } else {
      latencyMs = Date.now() - startTime;
      geminiError = err;
    }
  }

  // Write Telemetry
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || (tokensIn + tokensOut);
  // Approximate cost (Flash pricing: $0.15/1M in, $0.60/1M out)
  const costEstimate = parseFloat(((tokensIn * 0.00000015) + (tokensOut * 0.0000006)).toFixed(8));

  const logEntry = {
    event: "ai_generate_text",
    model: usedModel,
    latency_ms: latencyMs,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_usd: costEstimate,
    success: !geminiError,
    timestamp: new Date().toISOString(),
    ...(geminiError ? { error: geminiError.message } : {}),
  };
  
  console.log("[AI Telemetry]", JSON.stringify(logEntry));

  pool.query(`
    INSERT INTO ai_usage_log (
      user_id, org_id, feature, model,
      prompt_tokens, completion_tokens, total_tokens, cost_estimate_usd,
      latency_ms, cache_hit, success, error_message, source_ip
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [
    userId || null, orgId || null, 'generate_text', usedModel,
    tokensIn, tokensOut, totalTokens, costEstimate,
    latencyMs, false, !geminiError, geminiError ? geminiError.message : null, sourceIp || null
  ]).catch(err => {
    console.error("[AI Telemetry] Failed to write to ai_usage_log:", err.message);
  });

  if (geminiError) {
    throw geminiError;
  }

  return generatedText;
};

module.exports = {
  getAIUsageStats,
  enforceAILimits,
  generateGeneralText,
};
