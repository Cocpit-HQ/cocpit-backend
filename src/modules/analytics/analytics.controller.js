/**
 * Analytics Controller
 */

const analyticsService = require('./analytics.service');

exports.getOverview = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.id || req.user?.user_id; // Support token extraction patterns used in the codebase
        const { filter, startDate, endDate } = req.query;
        
        const data = await analyticsService.getOverviewData(userId, { filter, startDate, endDate });
        
        res.status(200).json({ status: 'success', data });
    } catch (err) {
        if (err.message === "User not found") {
            return res.status(404).json({ status: 'error', message: err.message });
        }
        next(err);
    }
};

exports.getAudience = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.id || req.user?.user_id;
        const { filter, startDate, endDate } = req.query;
        
        const data = await analyticsService.getAudienceData(userId, { filter, startDate, endDate });
        
        res.status(200).json({ status: 'success', data });
    } catch (err) {
        if (err.message === "User not found") {
            return res.status(404).json({ status: 'error', message: err.message });
        }
        next(err);
    }
};

exports.getOpportunities = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.id || req.user?.user_id;
        const { filter, startDate, endDate } = req.query;
        
        const data = await analyticsService.getOpportunitiesData(userId, { filter, startDate, endDate });
        
        res.status(200).json({ status: 'success', data });
    } catch (err) {
        if (err.message === "User not found") {
            return res.status(404).json({ status: 'error', message: err.message });
        }
        next(err);
    }
};

exports.getContent = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.id || req.user?.user_id;
        const { filter, startDate, endDate, sort } = req.query;
        
        const data = await analyticsService.getContentData(userId, { filter, startDate, endDate, sort });
        
        res.status(200).json({ status: 'success', data });
    } catch (err) {
        if (err.message === "User not found") {
            return res.status(404).json({ status: 'error', message: err.message });
        }
        next(err);
    }
};

exports.recordResumeEvent = async (req, res, next) => {
    try {
        const viewerId = req.user?.sub || req.user?.id || req.user?.user_id;
        const { targetUserId, eventType, orgId } = req.body;
        
        if (!targetUserId || !eventType) {
            return res.status(400).json({ status: 'error', message: 'targetUserId and eventType are required' });
        }
        
        if (eventType !== 'view' && eventType !== 'download') {
            return res.status(400).json({ status: 'error', message: 'eventType must be view or download' });
        }
        
        // Pass ip_address if needed, but not strictly required
        const ipAddress = req.ip || req.connection.remoteAddress;
        
        await analyticsService.recordResumeEvent(viewerId, targetUserId, eventType, ipAddress, orgId);
        
        res.status(200).json({ status: 'success', message: 'Event recorded' });
    } catch (err) {
        if (err.message === "Resume not found") {
            return res.status(404).json({ status: 'error', message: err.message });
        }
        next(err);
    }
};
