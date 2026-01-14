// require("newrelic");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const jobRoutes = require("./routes/job.routes");
const contentRoutes = require("./routes/content.routes");
const eventRoutes = require("./routes/event.routes");
const socialRoutes = require("./routes/social.routes");
const userRoutes = require("./routes/user.routes");
const uploadRoutes = require("./routes/upload.routes");
const onboardingRoutes = require("./routes/onboarding.routes");

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ["http://localhost:3000",
    "http://192.168.1.8:3000",
    "http://192.168.1.13:3000",
    "http://192.168.1.6:3000",
    "http://192.168.1.2:3000",
    "http://192.168.1.3:3000",
    "https://frontend.cocpit.in",
    ];

const corsOptions = {
  origin: allowedOrigins, // Array of allowed origins
  methods: 'GET,POST,PUT,DELETE,PATCH', // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
  credentials: true // Enables cookies/authorization headers to be sent
}

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Middleware to normalize URL and remove trailing slashes
app.use((req, res, next) => {
  req.url = req.url.replace(/\/+/g, '/');
  if (req.url.length > 1 && req.url.endsWith('/')) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api", profileRoutes); // /api/profile...
app.use("/api/jobs", jobRoutes);
app.use("/api", contentRoutes); // /api/feed, /api/stories... (following controller naming)
app.use("/api/events", eventRoutes);
app.use("/api", socialRoutes); // /api/conversations...
app.use("/api/users", userRoutes);
app.use("/api", uploadRoutes);
app.use("/api/onboarding", onboardingRoutes);

module.exports = app;
