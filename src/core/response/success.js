/**
 * Standardized Success Response
 * 
 * Usage:
 *   const { sendSuccess } = require('../core/response/success');
 *   sendSuccess(res, { user }, 200, 'User retrieved successfully');
 */
const sendSuccess = (res, data = null, statusCode = 200, message = null) => {
    const response = { success: true };
    if (message) response.message = message;
    if (data !== null) response.data = data;
    return res.status(statusCode).json(response);
};

module.exports = { sendSuccess };
