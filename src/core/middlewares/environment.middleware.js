const { getPool } = require("../db/connectionManager");

/**
 * Middleware to dynamically assign the database pool based on the x-environment header.
 * Defaults to 'staging' if the header is missing.
 */
const environmentMiddleware = (req, res, next) => {
  // Read environment from header (e.g., 'staging', 'uat', 'production')
  const envHeader = req.headers['x-environment'];
  const environment = envHeader ? envHeader.toLowerCase() : 'staging';

  try {
    // Get the appropriate database pool for the requested environment
    req.db = getPool(environment);
    req.currentEnvironment = environment;
    next();
  } catch (error) {
    console.error(`Failed to get database pool for environment: ${environment}`, error);
    res.status(500).json({ error: 'Database connection error for the specified environment.' });
  }
};

module.exports = environmentMiddleware;
