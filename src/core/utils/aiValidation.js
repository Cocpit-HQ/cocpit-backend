"use strict";

/**
 * Three-stage validation pipeline for AI-generated Job Description content.
 *
 * Stage 1 — Schema Validation  : all required fields present with correct types
 * Stage 2 — Business Validation: domain-level rules (experience ranges, lengths)
 * Stage 3 — Content Safety     : no HTML injection, PII, or discriminatory terms
 *
 * Each function throws an Error with { statusCode, field, message } on failure.
 * The controller catches these and maps them to HTTP 422.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fail = (field, message) => {
  const err = new Error(message);
  err.statusCode = 422;
  err.field = field;
  throw err;
};

// ─── Stage 1: Schema Validation ───────────────────────────────────────────────

const REQUIRED_STRING_FIELDS = [
  "title",
  "summary",
  "description",
  "education",
];

const REQUIRED_ARRAY_FIELDS = [
  "responsibilities",
  "requirements",
  "preferred_skills",
  "skills",
];

const REQUIRED_NUMBER_FIELDS = [];

/**
 * Validates that the AI response contains all required fields with correct types.
 * @param {object} data - Parsed AI response object
 */
const validateSchema = (data) => {
  if (!data || typeof data !== "object") {
    fail("root", "AI response is not a valid JSON object.");
  }

  // Detect the AI's own error signal for invalid role input
  if (data.error === "invalid_role") {
    fail("role", "The provided role was flagged as invalid by the AI model.");
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      fail(field, `Field "${field}" must be a non-empty string.`);
    }
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(data[field])) {
      fail(field, `Field "${field}" must be an array.`);
    }
    if (data[field].length === 0) {
      fail(field, `Field "${field}" must contain at least one item.`);
    }
    const hasNonString = data[field].some((item) => typeof item !== "string");
    if (hasNonString) {
      fail(field, `All items in "${field}" must be strings.`);
    }
  }

  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (typeof data[field] !== "number" || isNaN(data[field])) {
      fail(field, `Field "${field}" must be a number.`);
    }
  }
};

// ─── Stage 2: Business Validation ────────────────────────────────────────────

/**
 * Validates domain-level business rules on the AI-generated content.
 * @param {object} data - AI response (already schema-validated)
 */
const validateBusiness = (data) => {
  // Experience range (if provided)
  if (data.experience_min !== undefined) {
    if (data.experience_min < 0) {
      fail("experience_min", "experience_min cannot be negative.");
    }
  }
  if (data.experience_max !== undefined) {
    if (data.experience_min !== undefined && data.experience_max < data.experience_min) {
      fail(
        "experience_max",
        "experience_max must be greater than or equal to experience_min."
      );
    }
    if (data.experience_max > 50) {
      fail("experience_max", "experience_max cannot exceed 50 years.");
    }
  }

  // Title
  const titleLen = data.title.trim().length;
  if (titleLen < 3 || titleLen > 200) {
    fail("title", "Job title must be between 3 and 200 characters.");
  }

  // Summary
  const summaryLen = data.summary.trim().length;
  if (summaryLen < 20 || summaryLen > 1500) {
    fail("summary", "Summary must be between 20 and 1500 characters.");
  }

  // Responsibilities
  if (data.responsibilities.length < 2) {
    fail(
      "responsibilities",
      "At least 2 responsibilities are required."
    );
  }

  // Requirements
  if (data.requirements.length < 1) {
    fail("requirements", "At least 1 requirement is required.");
  }

  // Employment type must be one of the known values (if provided)
  if (data.employment_type) {
    const VALID_EMPLOYMENT_TYPES = [
      "full-time",
      "part-time",
      "contract",
      "internship",
      "freelance",
    ];
    if (!VALID_EMPLOYMENT_TYPES.includes(data.employment_type.toLowerCase())) {
      fail(
        "employment_type",
        `employment_type must be one of: ${VALID_EMPLOYMENT_TYPES.join(", ")}.`
      );
    }
  }
};

// ─── Stage 3: Content Safety Validation ──────────────────────────────────────

// Patterns that must NOT appear in AI-generated output
const SAFETY_PATTERNS = [
  {
    field: "general",
    pattern: /<[^>]+>/g,
    message: "HTML tags are not allowed in AI-generated content.",
  },
  {
    field: "general",
    pattern: /javascript:|on\w+\s*=/gi,
    message: "Script injection patterns detected in AI output.",
  },
  {
    field: "general",
    // Common discriminatory hiring language patterns
    pattern:
      /\b(must be (male|female|christian|hindu|muslim)|only (men|women)|no (foreigners|immigrants)|age (limit|restriction)|between \d+ and \d+ years? old)\b/gi,
    message:
      "Discriminatory hiring language detected. This content violates equal opportunity standards.",
  },
  {
    field: "general",
    // PII-like patterns: email, phone, Aadhar (12-digit), SSN (xxx-xx-xxxx)
    pattern:
      /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{12}\b|\b(\+91|0)[\s-]?\d{10}\b/g,
    message: "Personally Identifiable Information (PII) detected in AI output.",
  },
];

/**
 * Scans all string fields of the AI output for unsafe content.
 * @param {object} data - AI response (already business-validated)
 */
const validateContentSafety = (data) => {
  // Collect all text from the response into a single string for scanning
  const allStrings = [
    data.title,
    data.summary,
    data.description,
    data.employment_type,
    data.education,
    ...(data.responsibilities || []),
    ...(data.requirements || []),
    ...(data.preferred_skills || []),
    ...(data.skills || []),
    ...(data.benefits || []),
  ]
    .filter(Boolean)
    .join(" ");

  for (const { field, pattern, message } of SAFETY_PATTERNS) {
    if (pattern.test(allStrings)) {
      // Reset regex lastIndex (stateful patterns with /g flag)
      pattern.lastIndex = 0;
      fail(field, message);
    }
    pattern.lastIndex = 0;
  }
};

module.exports = { validateSchema, validateBusiness, validateContentSafety };
