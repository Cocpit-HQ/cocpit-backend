"use strict";

const MAX_RETRIES = 2;               // Attempts after the first failure (total 3)
const RETRY_BASE_DELAY_MS = 1_000;   // First retry: 1s, second: 2s (exponential)
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

/**
 * Wraps a promise with a hard timeout.
 * @param {Promise} promise
 * @param {number} ms - Timeout in milliseconds
 */
const withTimeout = (promise, ms) => {
  const timeout = new Promise((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      const err = new Error(`API call timed out after ${ms}ms`);
      err.isTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]);
};

/**
 * Sleeps for a given number of milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines if an error should trigger a retry.
 */
const isRetryable = (err) => {
  if (err.isTimeout) return true;
  const status = err.status || err.statusCode || err.httpErrorCode;
  return RETRYABLE_STATUS_CODES.has(status);
};

/**
 * Retries an async function up to MAX_RETRIES times on retryable errors.
 * Uses exponential backoff: delay = RETRY_BASE_DELAY_MS * 2^attempt
 *
 * @param {Function} fn - Async function to retry
 * @returns {Promise<any>}
 */
const withRetry = async (fn) => {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `⚠️  [AI Service] Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`,
          err.message
        );
        await sleep(delay);
      } else {
        break;
      }
    }
  }
  throw lastErr;
};

module.exports = {
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  RETRYABLE_STATUS_CODES,
  withTimeout,
  sleep,
  isRetryable,
  withRetry
};
