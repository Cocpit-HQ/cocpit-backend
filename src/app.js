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
const groupChatRoutes = require("./routes/groupChat.routes");
const companyRoutes = require("./routes/company.routes");
const chatSessionRoutes = require("./routes/chatSession.routes");

const app = express();
app.set("trust proxy", true);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ["http://localhost:3000",
    "http://192.168.1.8:3000",
    "http://192.168.1.13:3000",
    "http://192.168.1.6:3000",
    "http://192.168.1.2:3000",
    "http://192.168.1.3:3000",
    "http://192.168.1.7:3000",
    "http://192.168.1.5:3000",
    "http://192.168.1.4:3000",
    "https://frontend.cocpit.in",
  ];

const corsOptions = {
  origin: allowedOrigins, // Array of allowed origins
  methods: 'GET,POST,PUT,DELETE,PATCH', // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization', 'x-company-id'], // Allowed headers
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
app.use("/api", companyRoutes);
app.use("/api", groupChatRoutes); // /api/groups...
app.use("/api", chatSessionRoutes); // /api/company-chat-sessions...

// Global Error Handler
const errorHandler = require("./middlewares/error.middleware");
app.use(errorHandler);

module.exports = app;
