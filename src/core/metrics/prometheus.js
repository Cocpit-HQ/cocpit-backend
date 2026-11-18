const client = require('prom-client');

// Initialize default Node.js metrics collection (CPU, Memory, Event Loop, GC)
client.collectDefaultMetrics({
  prefix: 'cocpit_',
  timeout: 5000,
});

// Histogram for HTTP request duration in seconds
const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Counter for total HTTP requests
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status_code'],
});

// Gauge for active in-flight HTTP requests
const httpActiveRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'Number of active HTTP requests currently in-flight',
});

/**
 * Normalizes routes to avoid high metric cardinality from dynamic route parameters
 */
function normalizePath(rawPath) {
  if (!rawPath) return 'unknown';
  const cleanPath = rawPath.split('?')[0];
  return cleanPath
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/**
 * Express middleware to record request metrics
 */
function metricsMiddleware(req, res, next) {
  const url = req.originalUrl || req.url || '';
  if (url === '/metrics' || url === '/health' || url === '/api/health') {
    return next();
  }

  httpActiveRequests.inc();
  const stopTimer = httpRequestDurationSeconds.startTimer();

  res.on('finish', () => {
    httpActiveRequests.dec();

    let matchedRoute;
    if (req.baseUrl) {
      matchedRoute = `${req.baseUrl}${req.route?.path || normalizePath(req.path)}`;
    } else if (req.route?.path) {
      matchedRoute = req.route.path;
    } else {
      matchedRoute = normalizePath(req.path || url);
    }

    const labels = {
      method: req.method,
      route: matchedRoute || normalizePath(url),
      status_code: res.statusCode,
    };

    stopTimer(labels);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Endpoint handler to serve Prometheus scrape metrics
 */
async function metricsEndpoint(req, res) {
  try {
    res.setHeader('Content-Type', client.register.contentType);
    const metrics = await client.register.metrics();
    res.status(200).send(metrics);
  } catch (error) {
    res.status(500).send(`Error collecting metrics: ${error.message}`);
  }
}

module.exports = {
  client,
  register: client.register,
  metricsMiddleware,
  metricsEndpoint,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  httpActiveRequests,
};
