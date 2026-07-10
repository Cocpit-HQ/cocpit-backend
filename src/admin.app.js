const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const adminRoutes = require('./admin/routes/admin.routes');
const { adminGlobalLimiter } = require('./admin/middlewares/rateLimiter');
const errorHandler = require('./core/middlewares/error.middleware');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'admin' });
});

const authRoutes = require('./admin/routes/auth.routes');
app.use('/api/auth', authRoutes);

// Admin Routes
app.use('/api/admin', adminGlobalLimiter, adminRoutes);

// Error Handling
app.use(errorHandler);

module.exports = app;
