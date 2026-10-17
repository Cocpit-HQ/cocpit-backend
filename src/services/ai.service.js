"use strict";

/**
 * AI Service — Gemini JD Generation
 *
 * Provides a single entry point `generateJobDescription()` with:
 *   - In-memory Circuit Breaker (CLOSED → OPEN → HALF_OPEN)
 *   - 15-second hard timeout per Gemini call
 *   - Up to 2 retries with exponential backoff on retryable errors
 *   - Model fallback: gemini-2.5-flash → gemini-2.5-pro
 *   - Structured telemetry logging (prompt is NEVER logged in plaintext)
 */

const crypto = require("crypto");
const genAI = require("../config/gemini");
const { SYSTEM_INSTRUCTION, JD_JSON_SCHEMA, buildPrompt } = require("../prompts/jd-generator.v1");
const { SYSTEM_INSTRUCTION: RESUME_INSTRUCTION, RESUME_JSON_SCHEMA, buildPrompt: buildResumePrompt } = require("../prompts/resume-parser.v1");
const redisClient = require("../core/db/redis");
const pool = require("../core/db/pool");

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 15_000;           // Hard timeout per Gemini call
const { withTimeout, withRetry } = require("../core/ai/helpers");

const FALLBACK_JD = {
  title: "Professional Placeholder Title",
  summary: "We are currently looking for a dedicated and skilled professional to join our team. This role offers an exciting opportunity to work on impactful projects in a collaborative environment.",
  description: "As a key member of our organization, you will be responsible for driving results, collaborating with cross-functional teams, and contributing to our long-term success. We value innovation, commitment, and a proactive approach to problem-solving.",
  responsibilities: [
    "Contribute to the team's core projects and deliverables.",
    "Collaborate with internal and external stakeholders to achieve business goals.",
    "Maintain high standards of quality and performance in all tasks.",
    "Participate in regular team meetings and strategic planning sessions."
  ],
  requirements: [
    "Proven experience in a relevant professional capacity.",
    "Strong communication and interpersonal skills.",
    "Ability to work both independently and as part of a team.",
    "Excellent problem-solving and analytical abilities."
  ],
  preferred_skills: [
    "Experience with modern tools and methodologies related to the field.",
    "Strong project management or organizational skills.",
    "Adaptability in a fast-paced work environment."
  ],
  benefits: [
    "Competitive compensation package.",
    "Opportunities for professional growth and career advancement.",
    "Flexible work arrangements.",
    "Comprehensive health and wellness benefits."
  ],
  experience_min: 1,
  experience_max: 3,
  education: "Bachelor's degree or equivalent practical experience.",
  skills: ["Communication", "Teamwork", "Problem Solving", "Adaptability"],
  required_skills_keywords: ["Communication", "Teamwork", "Problem Solving", "Adaptability"]
};

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// In-memory; resets on process restart (acceptable for single-instance apps).
// For multi-instance deployments, move state to Redis.

const circuitBreaker = {
  state: "CLOSED",       // "CLOSED" | "OPEN" | "HALF_OPEN"
  failures: 0,
  openedAt: null,
  FAILURE_THRESHOLD: 5,         // Failures before circuit opens
  RECOVERY_TIMEOUT_MS: 30_000,  // How long circuit stays OPEN before going HALF_OPEN
};

const getCircuitState = () => {
  if (
    circuitBreaker.state === "OPEN" &&
    Date.now() - circuitBreaker.openedAt >= circuitBreaker.RECOVERY_TIMEOUT_MS
  ) {
    circuitBreaker.state = "HALF_OPEN";
    console.log("🔄 [AI Circuit Breaker] → HALF_OPEN — allowing probe request");
  }
  return circuitBreaker.state;
};

const recordSuccess = () => {
  circuitBreaker.failures = 0;
  circuitBreaker.state = "CLOSED";
  circuitBreaker.openedAt = null;
};

const recordFailure = () => {
  circuitBreaker.failures += 1;
  if (
    circuitBreaker.state !== "OPEN" &&
    circuitBreaker.failures >= circuitBreaker.FAILURE_THRESHOLD
  ) {
    circuitBreaker.state = "OPEN";
    circuitBreaker.openedAt = Date.now();
    console.error(
      `❌ [AI Circuit Breaker] → OPEN after ${circuitBreaker.failures} failures. ` +
      `Will retry in ${circuitBreaker.RECOVERY_TIMEOUT_MS / 1000}s.`
    );
  }
};

// ─── Helpers removed and extracted to core/ai/helpers.js ───────────

// ─── Core Gemini Call ─────────────────────────────────────────────────────────

/**
 * Calls the Gemini API with the given prompt and model.
 * Enforces a 15-second timeout.
 *
 * @param {Array<object>|string} promptParts - The user-turn prompt parts or text
 * @param {string} model      - Model identifier (e.g. "gemini-2.5-flash")
 * @param {string} systemInstruction - The system instruction prompt
 * @param {object} responseSchema - JSON schema for structured output
 * @returns {Promise<object>} - Parsed JSON response from Gemini
 */
const callGemini = async (promptParts, model, systemInstruction, responseSchema) => {
  const parts = Array.isArray(promptParts) ? promptParts : [{ text: promptParts }];
  const geminiCall = genAI.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      responseSchema: responseSchema,
      temperature: 0.7,
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

// ─── Retry Wrapper removed and extracted to core/ai/helpers.js ─────

// ─── Telemetry ────────────────────────────────────────────────────────────────

/**
 * Emits a structured telemetry log.
 * The role is NEVER logged in plaintext — only its SHA256 hash.
 */
const emitTelemetry = ({
  role,
  jobId,
  companyId,
  userId,
  orgId,
  sourceIp,
  model,
  startTime,
  usageMetadata,
  retryCount,
  cached,
  circuitState,
  error,
}) => {
  const roleHash = crypto
    .createHash("sha256")
    .update(role || "")
    .digest("hex")
    .slice(0, 16); // Short hash for log correlation

  const tokensIn = usageMetadata?.promptTokenCount || 0;
  const tokensOut = usageMetadata?.candidatesTokenCount || 0;
  const totalTokens = usageMetadata?.totalTokenCount || (tokensIn + tokensOut);

  // Approximate cost (Flash pricing: $0.15/1M in, $0.60/1M out)
  const costEstimate = parseFloat(
    ((tokensIn * 0.00000015) + (tokensOut * 0.0000006)).toFixed(8)
  );

  const latencyMs = Date.now() - startTime;

  const logEntry = {
    event: `ai_${role}`,
    role_hash: roleHash,
    job_id: jobId,
    company_id: companyId,
    model,
    latency_ms: latencyMs,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_usd: costEstimate,
    retry_count: retryCount,
    cached,
    circuit_state: circuitState,
    timestamp: new Date().toISOString(),
    ...(error ? { error: error.message } : {}),
  };

  console.log("[AI Telemetry]", JSON.stringify(logEntry));

  // Write to DB Ledger
  pool.query(`
    INSERT INTO ai_usage_log (
      user_id, org_id, feature, related_entity_id, model,
      prompt_tokens, completion_tokens, total_tokens, cost_estimate_usd,
      latency_ms, cache_hit, success, error_message, source_ip
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    userId || null, orgId || null, role || 'jd_generate', jobId || null, model,
    tokensIn, tokensOut, totalTokens, costEstimate,
    latencyMs, cached || false, !error, error ? error.message : null, sourceIp || null
  ]).catch(err => {
    console.error("[AI Telemetry] Failed to write to ai_usage_log:", err.message);
  });
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a Job Description using the Gemini API.
 *
 * @param {object} params
 * @param {string} params.role        - Job title (e.g. "Software Engineer")
 * @param {string} params.companyName - Optional company name for context
 * @param {string} params.jobId       - DB job ID (for telemetry)
 * @param {string} params.companyId   - Org/company ID (for telemetry)
 * @returns {Promise<object>} Validated structured JD JSON from Gemini
 */
const normalizeString = (str) => {
  if (!str) return "";
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

const injectCompanyName = (dataObj, companyName) => {
  if (!dataObj) return dataObj;
  const nameToUse = companyName || "our company";

  if (typeof dataObj === "string") {
    return dataObj.replace(/\[Company Name\]/g, nameToUse);
  }

  if (Array.isArray(dataObj)) {
    return dataObj.map(item => injectCompanyName(item, companyName));
  }

  if (typeof dataObj === "object") {
    const newObj = {};
    for (const key in dataObj) {
      newObj[key] = injectCompanyName(dataObj[key], companyName);
    }
    return newObj;
  }

  return dataObj;
};

const generateJobDescription = async ({
  role,
  companyName = null,
  location = null,
  experience = null,
  work_type = null,
  work_mode = null,
  jobId,
  companyId,
  userId = null,
  orgId = null,
  sourceIp = null,
}) => {
  const startTime = Date.now();
  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash";
  const fallbackModel = process.env.AI_FALLBACK_MODEL || "gemini-2.0-flash";
  const promptVersion = "v1.0";

  let retryCount = 0;
  let usedModel = primaryModel;
  let usageMetadata = {};

  // 1. Normalization & Hashing
  const normalizedRole = normalizeString(role);
  const cacheKeyStr = `${normalizedRole}|${companyName || ''}|${location || ''}|${experience || ''}|${work_type || ''}|${work_mode || ''}|${promptVersion}`;
  const roleHash = crypto.createHash("sha256").update(cacheKeyStr).digest("hex");
  const redisCacheKey = `jd_cache:${roleHash}`;
  const redisLockKey = `jd_lock:${roleHash}`;

  // 2. Tier 1: Redis Cache
  if (redisClient.isOpen) {
    try {
      const cached = await redisClient.get(redisCacheKey);
      if (cached) {
        console.log(`⚡ [AI Service] Redis Cache HIT for role: ${role}`);
        pool.query(`UPDATE ai_jd_cache SET hit_count = hit_count + 1, last_used_at = NOW() WHERE role_hash = $1`, [roleHash]).catch(e => console.error("Async DB update failed", e));
        return injectCompanyName(JSON.parse(cached), companyName);
      }
    } catch (err) {
      console.error("Redis read error:", err);
    }
  }

  // 3. Tier 2: PostgreSQL Cache
  try {
    const dbRes = await pool.query(`SELECT ai_content FROM ai_jd_cache WHERE role_hash = $1 AND expires_at > NOW()`, [roleHash]);
    if (dbRes.rows.length > 0) {
      console.log(`🐘 [AI Service] Postgres Cache HIT for role: ${role}`);
      const content = dbRes.rows[0].ai_content;
      if (redisClient.isOpen) {
        redisClient.setEx(redisCacheKey, 3600, JSON.stringify(content)).catch(e => console.error(e));
      }
      pool.query(`UPDATE ai_jd_cache SET hit_count = hit_count + 1, last_used_at = NOW() WHERE role_hash = $1`, [roleHash]).catch(e => console.error(e));
      return injectCompanyName(content, companyName);
    }
  } catch (err) {
    console.error("Postgres read error:", err);
  }

  // 4. Cache Stampede Protection (Distributed Lock)
  let lockAcquired = false;
  if (redisClient.isOpen) {
    try {
      const isEnabled = await redisClient.get("config:ai_generation_enabled");
      if (isEnabled === "false") {
        console.log(`⚡ [AI Service] AI Generation is disabled via config. Using fallback JD for: ${role}`);
        return injectCompanyName({ ...FALLBACK_JD, title: role }, companyName);
      }
    } catch (err) {
      console.error("Redis config check error:", err);
    }

    const result = await redisClient.set(redisLockKey, "1", "PX", 15000, "NX");
    if (!result) {
      console.log(`⏳ [AI Service] Cache stampede prevented! Waiting for lock on: ${role}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      const retryCache = await redisClient.get(redisCacheKey);
      if (retryCache) return injectCompanyName(JSON.parse(retryCache), companyName);
    } else {
      lockAcquired = true;
    }
  }

  // ── Circuit Breaker Check ──────────────────────────────────────────────────
  const cbState = getCircuitState();
  if (cbState === "OPEN") {
    if (lockAcquired && redisClient.isOpen) await redisClient.del(redisLockKey);
    const err = new Error(
      "AI service circuit breaker is OPEN. Too many recent failures. Please try again shortly."
    );
    err.statusCode = 503;
    emitTelemetry({ role, jobId, companyId, userId, orgId, sourceIp, model: primaryModel, startTime, usageMetadata: {}, retryCount: 0, cached: false, circuitState: "OPEN", error: err });
    
    console.log(`⚡ [AI Service] Circuit breaker is OPEN. Returning fallback JD for: ${role}`);
    return injectCompanyName({ ...FALLBACK_JD, title: role }, companyName);
  }

  const promptText = buildPrompt(role, companyName, location, experience, work_type, work_mode);

  const cleanupLock = async () => {
    if (lockAcquired && redisClient.isOpen) {
      await redisClient.del(redisLockKey).catch(e => console.error(e));
    }
  };

  const persistCache = async (data) => {
    try {
      if (redisClient.isOpen) {
         await redisClient.setEx(redisCacheKey, 3600, JSON.stringify(data));
      }
      await pool.query(`
        INSERT INTO ai_jd_cache (role_hash, role_name, company_name, ai_content, prompt_version)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (role_hash) DO UPDATE SET
          ai_content = EXCLUDED.ai_content,
          last_used_at = NOW(),
          expires_at = NOW() + INTERVAL '30 days'
      `, [roleHash, role, companyName, JSON.stringify(data), promptVersion]);
    } catch (e) {
      console.error("Cache persistence error:", e);
    }
  };

  // ── Primary Model Attempt ─────────────────────────────────────────────────
  try {
    const primaryAttempt = await withRetry(async () => {
      retryCount++;
      return callGemini(promptText, primaryModel, SYSTEM_INSTRUCTION, JD_JSON_SCHEMA);
    });
    retryCount = retryCount - 1;

    usageMetadata = primaryAttempt.usageMetadata;
    recordSuccess();

    await persistCache(primaryAttempt.data);
    await cleanupLock();

    emitTelemetry({ role, jobId, companyId, userId, orgId, sourceIp, model: primaryModel, startTime, usageMetadata, retryCount, cached: false, circuitState: "CLOSED" });
    return injectCompanyName(primaryAttempt.data, companyName);

  } catch (primaryErr) {
    console.error(`❌ [AI Service] Primary model "${primaryModel}" failed after retries:`, primaryErr.message);

    // ── Fallback Model Attempt ───────────────────────────────────────────────
    try {
      console.log(`🔄 [AI Service] Falling back to "${fallbackModel}"...`);
      usedModel = fallbackModel;

      const fallbackAttempt = await callGemini(promptText, fallbackModel, SYSTEM_INSTRUCTION, JD_JSON_SCHEMA);
      usageMetadata = fallbackAttempt.usageMetadata;
      recordSuccess();

      await persistCache(fallbackAttempt.data);
      await cleanupLock();

      emitTelemetry({ role, jobId, companyId, userId, orgId, sourceIp, model: fallbackModel, startTime, usageMetadata, retryCount, cached: false, circuitState: cbState });
      return injectCompanyName(fallbackAttempt.data, companyName);

    } catch (fallbackErr) {
      console.error(`❌ [AI Service] Fallback model "${fallbackModel}" also failed:`, fallbackErr.message);
      recordFailure();
      await cleanupLock();

      emitTelemetry({ role, jobId, companyId, userId, orgId, sourceIp, model: usedModel, startTime, usageMetadata, retryCount, cached: false, circuitState: circuitBreaker.state, error: fallbackErr });
      
      console.log(`⚡ [AI Service] Returning fallback JD due to total failure for: ${role}`);
      return injectCompanyName({ ...FALLBACK_JD, title: role }, companyName);
    }
  }
};

/**
 * Parses a resume file using Gemini.
 *
 * @param {object} params
 * @param {Buffer} params.fileBuffer - File buffer of the resume
 * @param {string} params.mimeType   - Mime type (e.g., 'application/pdf')
 * @param {string} params.userId     - User ID
 * @param {string} params.sourceIp   - Source IP for telemetry
 * @returns {Promise<object>} Parsed JSON
 */
const parseResume = async ({ fileBuffer, mimeType, userId, sourceIp }) => {
  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash-lite";
  const fallbackModel = process.env.AI_FALLBACK_MODEL || "gemini-2.5-flash";
  const startTime = Date.now();
  let retryCount = 0;
  let usageMetadata = {};

  const cbState = getCircuitState();
  if (cbState === "OPEN") {
    const err = new Error("AI service circuit breaker is OPEN. Please try again shortly.");
    err.statusCode = 503;
    emitTelemetry({ role: "resume_parse", userId, sourceIp, model: primaryModel, startTime, usageMetadata: {}, retryCount: 0, cached: false, circuitState: "OPEN", error: err });
    throw err;
  }

  const promptText = buildResumePrompt(""); // empty text since we rely on file content
  const promptParts = [
    { inlineData: { data: fileBuffer.toString("base64"), mimeType } },
    { text: promptText }
  ];

  try {
    const attempt = await withRetry(async () => {
      retryCount++;
      return callGemini(promptParts, primaryModel, RESUME_INSTRUCTION, RESUME_JSON_SCHEMA);
    });
    retryCount = retryCount - 1;

    usageMetadata = attempt.usageMetadata;
    recordSuccess();

    emitTelemetry({ role: "resume_parse", userId, sourceIp, model: primaryModel, startTime, usageMetadata, retryCount, cached: false, circuitState: "CLOSED" });
    
    return attempt.data;
  } catch (err) {
    recordFailure();
    
    // Attempt fallback logic if primary fails
    if (fallbackModel && fallbackModel !== primaryModel) {
      console.warn(`⚠️ [AI Service] Primary model (${primaryModel}) failed for resume parse. Falling back to ${fallbackModel}...`);
      try {
        const fallbackAttempt = await withRetry(async () => {
          retryCount++;
          return callGemini(promptParts, fallbackModel, RESUME_INSTRUCTION, RESUME_JSON_SCHEMA);
        });
        
        usageMetadata = fallbackAttempt.usageMetadata;
        recordSuccess();
        
        emitTelemetry({ role: "resume_parse", userId, sourceIp, model: fallbackModel, startTime, usageMetadata, retryCount, cached: false, circuitState: "CLOSED" });
        
        return fallbackAttempt.data;
      } catch (fallbackErr) {
        recordFailure();
        const cbState = getCircuitState();
        emitTelemetry({ role: "resume_parse", userId, sourceIp, model: fallbackModel, startTime, usageMetadata, retryCount, cached: false, circuitState: cbState, error: fallbackErr });
        throw fallbackErr;
      }
    } else {
      const cbState = getCircuitState();
      emitTelemetry({ role: "resume_parse", userId, sourceIp, model: primaryModel, startTime, usageMetadata, retryCount, cached: false, circuitState: cbState, error: err });
      throw err;
    }
  }
};

/**
 * Exposed for testing — allows tests to reset the circuit breaker state.
 */
const resetCircuitBreaker = () => {
  circuitBreaker.state = "CLOSED";
  circuitBreaker.failures = 0;
  circuitBreaker.openedAt = null;
};

module.exports = { generateJobDescription, parseResume, resetCircuitBreaker };
