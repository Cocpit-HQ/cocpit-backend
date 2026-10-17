// Base URL the admin module uses to call Main API internal endpoints.
// In the monolith both live in the same process, so loopback on PORT is the default.
const MAIN_API_INTERNAL_URL = (
  process.env.MAIN_API_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 5000}`
).replace(/\/+$/, '');

module.exports = { MAIN_API_INTERNAL_URL };
