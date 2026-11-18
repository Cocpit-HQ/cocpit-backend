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

// Gauge for live active users (WebSocket real-time & rolling 5-minute active window)
const liveUsersGauge = new client.Gauge({
  name: 'cocpit_live_users',
  help: 'Number of live concurrent active users',
  labelNames: ['type'],
});

// Gauge for total connected client WebSockets
const connectedSocketsGauge = new client.Gauge({
  name: 'cocpit_connected_sockets_total',
  help: 'Total count of connected client sockets',
});

// Gauge for unique active users per day (Sunday through Saturday weekly breakdown)
const dailyActiveUsersGauge = new client.Gauge({
  name: 'cocpit_daily_active_users',
  help: 'Count of unique active users per day of the week',
  labelNames: ['day', 'date', 'day_index'],
});

// In-memory sliding window for fast local tracking
const activeUsersWindow = new Map(); // userId -> lastSeenTimestamp
const dailyUsersSet = new Map(); // YYYY-MM-DD -> Set(userId)

/**
 * Record an active user interaction (HTTP or WebSocket)
 */
function recordActiveUser(userId) {
  if (!userId) return;
  const now = Date.now();
  activeUsersWindow.set(userId, now);

  const today = new Date().toISOString().slice(0, 10);
  if (!dailyUsersSet.has(today)) {
    dailyUsersSet.set(today, new Set());
  }
  dailyUsersSet.get(today).add(userId);

  // Non-blocking sync to Redis
  try {
    const redis = require('../db/redis');
    if (redis && (redis.isOpen || redis.status === 'ready')) {
      redis.zadd('cocpit:active_users_5m', now, userId).catch(() => {});
      redis
        .sadd(`cocpit:dau:${today}`, userId)
        .then(() => {
          redis.expire(`cocpit:dau:${today}`, 86400 * 14).catch(() => {});
        })
        .catch(() => {});
    }
  } catch (_) {
    // Non-blocking fallback to in-memory
  }
}

let lastDbSync = 0;
const DB_SYNC_INTERVAL = 30 * 1000; // 30 seconds cache

/**
 * Synchronize and collect live user metrics before Prometheus scrape
 */
async function collectUserMetrics() {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  // 1. Purge expired in-memory active users
  for (const [uid, lastSeen] of activeUsersWindow.entries()) {
    if (lastSeen < fiveMinAgo) {
      activeUsersWindow.delete(uid);
    }
  }

  // 2. Collect real-time WebSocket counts
  let wsUsers = 0;
  let wsSockets = 0;
  try {
    const socketService = require('../infrastructure/socket.service');
    if (socketService) {
      wsUsers =
        typeof socketService.getOnlineUserCount === 'function'
          ? socketService.getOnlineUserCount()
          : 0;
      wsSockets =
        typeof socketService.getConnectedSocketCount === 'function'
          ? socketService.getConnectedSocketCount()
          : 0;
    }
  } catch (_) {
    // Non-blocking
  }

  // 3. Collect rolling 5-minute active users from Redis or in-memory
  let active5mUsers = activeUsersWindow.size;
  try {
    const redis = require('../db/redis');
    if (redis && (redis.isOpen || redis.status === 'ready')) {
      await redis.zremrangebyscore('cocpit:active_users_5m', 0, fiveMinAgo);
      const redisCount = await redis.zcard('cocpit:active_users_5m');
      if (typeof redisCount === 'number' && redisCount > active5mUsers) {
        active5mUsers = redisCount;
      }
    }
  } catch (_) {
    // Fallback to in-memory count
  }

  liveUsersGauge.set({ type: 'websocket' }, wsUsers);
  liveUsersGauge.set({ type: 'active_5m' }, Math.max(active5mUsers, wsUsers));
  connectedSocketsGauge.set(wsSockets);

  // 4. Update daily active users (Weekly breakdown Sun - Sat)
  if (now - lastDbSync > DB_SYNC_INTERVAL) {
    lastDbSync = now;
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dbCountsMap = new Map();

    try {
      const pool = require('../db/pool');
      const query = `
        WITH daily_activities AS (
          SELECT user_id, date_trunc('day', created_at) AS day_ts
          FROM user_activity_log
          WHERE created_at >= NOW() - INTERVAL '7 days'
          UNION
          SELECT user_id, date_trunc('day', created_at) AS day_ts
          FROM refresh_tokens
          WHERE created_at >= NOW() - INTERVAL '7 days'
        )
        SELECT 
          to_char(day_ts, 'YYYY-MM-DD') AS date_str,
          COUNT(DISTINCT user_id)::int AS unique_users
        FROM daily_activities
        GROUP BY day_ts;
      `;
      const dbRes = await pool.query(query);
      if (dbRes && dbRes.rows) {
        for (const r of dbRes.rows) {
          dbCountsMap.set(r.date_str, r.unique_users);
        }
      }
    } catch (_) {
      // Non-blocking
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayMemoryCount = dailyUsersSet.get(todayStr)?.size || 0;

    dailyActiveUsersGauge.reset();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 86400 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = dayNames[d.getDay()];
      const dbCount = dbCountsMap.get(dateStr) || 0;
      const finalCount = dateStr === todayStr ? Math.max(dbCount, todayMemoryCount) : dbCount;

      dailyActiveUsersGauge.set(
        { day: dayName, date: dateStr, day_index: String(d.getDay()) },
        finalCount
      );
    }
  }
}

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

    // Track active user if authenticated
    const userId = req.user?.sub || req.user?.user_id;
    if (userId) {
      recordActiveUser(userId);
    }
  });

  next();
}

/**
 * Endpoint handler to serve Prometheus scrape metrics
 */
async function metricsEndpoint(req, res) {
  try {
    await collectUserMetrics();
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
  recordActiveUser,
  collectUserMetrics,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  httpActiveRequests,
  liveUsersGauge,
  connectedSocketsGauge,
  dailyActiveUsersGauge,
};
