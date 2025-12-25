const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");

const app = express();

app.use(cors());
app.use(express.json());

// Middleware to normalize URL and remove trailing slashes
app.use((req, res, next) => {
  req.url = req.url.replace(/\/+/g, '/');
  if (req.url.length > 1 && req.url.endsWith('/')) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

app.use("/api/auth", authRoutes);

module.exports = app;
