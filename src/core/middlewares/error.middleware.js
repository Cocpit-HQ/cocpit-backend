const AppError = require('../errors/AppError');

const errorHandler = (err, req, res, next) => {
    if (err.name === 'MulterError' && !err.statusCode) {
        err.statusCode = 400;
    }
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log error (for production, might want better logging)
    console.error("❌ ERROR:", err);

    const isDev = process.env.NODE_ENV === 'development';
    res.status(err.statusCode).json({
        status: err.status,
        message: err.message,
        ...(isDev && { error: err, stack: err.stack })
    });
};

module.exports = errorHandler;
