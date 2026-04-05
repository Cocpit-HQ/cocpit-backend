const AppError = require('../errors/AppError');

const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log error (for production, might want better logging)
    console.error("❌ ERROR:", err);

    // Temporarily always show full error for debugging
    res.status(err.statusCode).json({
        status: err.status,
        error: err,
        message: err.message,
        stack: err.stack
    });
};

module.exports = errorHandler;
