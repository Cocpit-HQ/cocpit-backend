const { requireOrgPermission, requireCompanyPermission, requireRolePriority } = require("./organization.auth.middleware");

module.exports = {
    requireOrgPermission,
    requireCompanyPermission,
    requireRolePriority
};
