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
const onboardingRoutes = require("./modules/auth/onboarding.routes");
const messagingRoutes = require("./modules/messaging/messaging.routes");
const organizationRoutes = require("./modules/organization/organization.routes");
const shareRoutes = require("./modules/share/share.routes");
const dashboardRoutes = require("./modules/dashboard/dashboard.routes");
const reportRoutes = require("./modules/report/report.routes");
const activityRoutes = require("./modules/activity/activity.routes");
const locationRoutes = require("./modules/location/location.routes");



const app = express();
app.set("trust proxy", 1);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin ||
      origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
      origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/) ||
      origin.match(/^https:\/\/.*\.ngrok-free\.(app|dev)$/) ||
      origin.match(/^https:\/\/.*\.loca\.lt$/) ||
      origin === "https://frontend.cocpit.in") {
      callback(null, true);
    } else if (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
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
  ],
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static("uploads"));

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

app.use("/api/dashboard", dashboardRoutes);
app.use("/api", reportRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", profileRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api", contentRoutes);
app.use("/api", hashtagRoutes);
app.use("/api/events", eventRoutes);
app.use("/api", socialRoutes);
app.use("/api/users", userRoutes);
app.use("/api", uploadRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api", organizationRoutes);
app.use("/api", messagingRoutes);
app.use("/api", activityRoutes);
app.use("/api", shareRoutes);
app.use("/api", locationRoutes);
const errorHandler = require("./core/middlewares/error.middleware");
app.use(errorHandler);

module.exports = app;
