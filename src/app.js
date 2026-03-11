const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const authRoutes = require("./modules/auth/auth.routes");
const profileRoutes = require("./modules/profile/profile.routes");
const jobRoutes = require("./modules/jobs/job.routes");
const contentRoutes = require("./modules/content/content.routes");
const eventRoutes = require("./modules/events/event.routes");
const socialRoutes = require("./modules/social/social.routes");
const userRoutes = require("./modules/user/user.routes");
const uploadRoutes = require("./modules/upload/upload.routes");
const onboardingRoutes = require("./modules/auth/onboarding.routes");
const messagingRoutes = require("./modules/messaging/messaging.routes");
const organizationRoutes = require("./modules/organization/organization.routes");
const shareRoutes = require("./modules/share/share.routes");

const app = express();
app.set("trust proxy", 1);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin ||
      origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
      origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/) ||
      origin === "https://frontend.cocpit.in") {
      callback(null, true);
    } else if (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS', // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization', 'x-company-id', 'x-org-id'], // Allowed headers
  credentials: true // Enables cookies/authorization headers to be sent
}

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static("uploads"));

// Middleware to normalize URL and remove trailing slashes
app.use((req, res, next) => {
  req.url = req.url.replace(/\/+/g, '/');
  if (req.url.length > 1 && req.url.endsWith('/')) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

// Middleware to log request latency for monitoring performance
app.use((req, res, next) => {
  const start = performance.now();
  res.on('finish', () => {
    const duration = Math.round(performance.now() - start);
    if (req.originalUrl.includes('/auth/')) {
       console.log(`⏱️ [PERF] [${req.method}] ${req.originalUrl} took ${duration}ms`);
    }
  });
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api", profileRoutes); // /api/profile...
app.use("/api/jobs", jobRoutes);
app.use("/api", contentRoutes); // /api/feed, /api/stories...
app.use("/api/events", eventRoutes);
app.use("/api", socialRoutes); // /api/conversations...
app.use("/api/users", userRoutes);
app.use("/api", uploadRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api", organizationRoutes); // Supporting both /api/organizations and legacy /api/companies
app.use("/api", messagingRoutes); // /api/groups... + /api/company-chat-sessions...
app.use("/api", shareRoutes); // /api/share + /api/entity/preview

// Global Error Handler
const errorHandler = require("./core/middlewares/error.middleware");
app.use(errorHandler);

module.exports = app;
