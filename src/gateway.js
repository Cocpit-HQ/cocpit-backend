const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.GATEWAY_PORT || 8000;
const MAIN_API_URL = process.env.MAIN_API_URL || process.env.MAIN_API_INTERNAL_URL || process.env.API_URL || 'http://localhost:5000';
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:5001';

// Request ID Middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || uuidv4();
  // Ensure the header is set for the proxies to pick up automatically
  req.headers['x-request-id'] = requestId;
  // Send it back to the client as well
  res.setHeader('X-Request-ID', requestId);
  
  console.log(`[Gateway] Request ID: ${requestId} -> ${req.method} ${req.url}`);
  next();
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'gateway' });
});

// Proxy to Admin API
app.use('/api/admin', createProxyMiddleware({
  target: ADMIN_API_URL,
  changeOrigin: true,
  // The middleware automatically forwards headers from req.headers, including our x-request-id
  on: {
    proxyRes: (proxyRes, req) => {
      // Optional: Log response status
      console.log(`[Gateway] Request ID: ${req.headers['x-request-id']} <- [Admin API] ${proxyRes.statusCode}`);
    },
    error: (err, req) => {
      console.error(`[Gateway] Request ID: ${req.headers['x-request-id']} - Error Proxying to Admin API:`, err.message);
    }
  }
}));

// Proxy to Main API (Everything else, including WebSockets)
app.use('/', createProxyMiddleware({
  target: MAIN_API_URL,
  changeOrigin: true,
  ws: true, // Enable WebSockets for Socket.io
  on: {
    proxyRes: (proxyRes, req) => {
      console.log(`[Gateway] Request ID: ${req.headers['x-request-id']} <- [Main API] ${proxyRes.statusCode}`);
    },
    error: (err, req) => {
      console.error(`[Gateway] Request ID: ${req.headers['x-request-id']} - Error Proxying to Main API:`, err.message);
    }
  }
}));

// Graceful Shutdown
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Gateway] Running on port ${PORT}`);
  console.log(`[Gateway] Routing /api/admin -> ${ADMIN_API_URL}`);
  console.log(`[Gateway] Routing /* -> ${MAIN_API_URL}`);
});

process.on('SIGINT', () => {
  console.log('\n[Gateway] SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('[Gateway] Closed out remaining connections.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Gateway] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('[Gateway] Closed out remaining connections.');
    process.exit(0);
  });
});
