// Legacy location — re-exports from core for backward compatibility
const { checkOrgPermission, checkCompanyPermission } = require("../core/utils/rbac");
module.exports = { checkOrgPermission, checkCompanyPermission };
