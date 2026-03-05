// Legacy location — re-exports from core for backward compatibility
const { requireOrgPermission, requireCompanyPermission, requireRolePriority } = require("../core/middlewares/company.auth.middleware");
module.exports = { requireOrgPermission, requireCompanyPermission, requireRolePriority };
