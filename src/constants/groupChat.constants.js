/**
 * Group Chat Constants
 * Centralized Single Source of Truth (SSOT) for group chat limits and configurations.
 * To change group member limits in the future, modify MAX_GROUP_MEMBERS here or set the MAX_GROUP_MEMBERS env variable.
 */

const MAX_GROUP_MEMBERS = parseInt(process.env.MAX_GROUP_MEMBERS, 10) || 256;

module.exports = {
    MAX_GROUP_MEMBERS,
};
