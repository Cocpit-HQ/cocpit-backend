const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const authRoutes = require("./modules/auth/auth.routes");
const profileRoutes = require("./modules/profile/profile.routes");
const jobRoutes = require("./modules/jobs/job.routes");
const contentRoutes = require("./modules/content/content.routes");
const hashtagRoutes = require("./modules/content/hashtag.routes");
const eventRoutes = require("./modules/events/event.routes");
const socialRoutes = require("./modules/social/social.routes");
const userRoutes = require("./modules/user/user.routes");
const uploadRoutes = require("./modules/upload/upload.routes");
const onboardingRoutes = require("./modules/onboarding/onboarding.routes");
const messagingRoutes = require("./modules/messaging/messaging.routes");
const organizationRoutes = require("./modules/organization/organization.routes");
const orgProfileRoutes = require("./modules/organization/organization.profile.routes");
const orgTeamsRoutes = require("./modules/organization/organization.teams.routes");
const communityRoutes = require("./modules/community/community.routes");
const shareRoutes = require("./modules/share/share.routes");
const dashboardRoutes = require("./modules/dashboard/dashboard.routes");
const reportRoutes = require("./modules/report/report.routes");
const activityRoutes = require("./modules/activity/activity.routes");
const configRoutes = require("./modules/config/config.routes");
const deviceRoutes = require("./modules/device/device.routes");
const feedRoutes = require("./modules/feed/feed.routes");
const placesRoutes = require("./modules/places/places.routes");
const analyticsRoutes = require("./modules/analytics/analytics.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const userSettingsRoutes = require("./modules/user/userSettings.routes");
const { optionalAuth } = require("./core/middlewares/auth.middleware");
const { enforceOnboarding } = require("./core/middlewares/onboarding.middleware");



const app = express();
app.set("trust proxy", 1);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin ||
      origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
      origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/) ||
      origin.match(/^https:\/\/.*\.ngrok-free\.(app|dev)$/) ||
      origin.match(/^https:\/\/.*\.loca\.lt$/) ||
      origin === "https://frontend.cocpit.in" ||
      origin === "https://cocpit-frontend-staging.up.railway.app/" ||
      origin === "https://uat.cocpit.in"
    ) {
      callback(null, true);
    } else if (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-actor-type",
    "x-actor-id",
    "x-company-id",
    "x-org-id",
    "x-internal-secret",
  ],
  credentials: true,
};

app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

app.use((req, res, next) => {
  req.url = req.url.replace(/\/+/g, "/");
  if (req.url.length > 1 && req.url.endsWith("/")) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const duration = Math.round(performance.now() - start);
    if (req.originalUrl.includes("/auth/")) {
      console.log(`[PERF] [${req.method}] ${req.originalUrl} took ${duration}ms`);
    }

  });
  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/config", configRoutes);

const publicAppealRoutes = require("./modules/public_appeal/public_appeal.routes");

// Global Onboarding Enforcement for all other /api routes
// optionalAuth extracts user from token without blocking; enforceOnboarding blocks if onboarding is incomplete

app.use("/api/public/appeals", publicAppealRoutes);

app.use("/api", optionalAuth);
app.use("/api", enforceOnboarding);

app.use("/api/dashboard", dashboardRoutes);
app.use("/api/report", reportRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api", contentRoutes);
app.use("/api", hashtagRoutes);
app.use("/api/events", eventRoutes);
app.use("/api", socialRoutes);
app.use("/api/users", userRoutes);
app.use("/api", uploadRoutes);
app.use("/api/organizations", orgProfileRoutes);
app.use("/api/organizations/:orgId/teams", orgTeamsRoutes);
app.use("/api", communityRoutes);
app.use("/api", organizationRoutes);
app.use("/api", messagingRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api", shareRoutes);
app.use("/api/places", placesRoutes);
app.use("/api/device", deviceRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/user", userSettingsRoutes);
const errorHandler = require("./core/middlewares/error.middleware");
app.use(errorHandler);

module.exports = app;
