const axios = require('axios');
const axiosRetry = require('axios-retry').default;

const mainApiBase = (process.env.MAIN_API_INTERNAL_URL || process.env.MAIN_API_URL || `http://localhost:5000`).replace(/\/$/, '');

// Configure the internal API client
const httpClient = axios.create({
  baseURL: `${mainApiBase}/api/internal`, // Points to Main API
  timeout: 5000, // 5 seconds strict timeout
  headers: {
    'x-internal-api-secret': process.env.INTERNAL_API_SECRET
  }
});

// Configure Exponential Backoff Retries
axiosRetry(httpClient, {
  retries: 3, // Number of retries
  retryDelay: axiosRetry.exponentialDelay, // 100ms, 200ms, 400ms...
  retryCondition: (error) => {
    // Retry on network errors or 5xx server errors
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
  }
});

module.exports = httpClient;
