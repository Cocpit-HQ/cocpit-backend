/**
 * Standardized Error Response
 * 
 * Usage:
 *   const { sendError } = require('../core/response/error');
 *   sendError(res, 'NOT_FOUND', 'User not found', 404);
 */
const sendError = (res, code = 'INTERNAL_ERROR', message = 'Internal server error', statusCode = 500) => {
    return res.status(statusCode).json({
        success: false,
        error: {
            code,
            message,
        },
    });
};

module.exports = { sendError };
