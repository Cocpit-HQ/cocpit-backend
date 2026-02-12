const express = require("express");
const router = express.Router();
const companyController = require("../controllers/company.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");

// Public (or optional auth)
router.get("/companies/check-slug", optionalAuth, companyController.checkSlug); // Make optional to avoid 401s on simple checks
router.get("/companies/mine", requireAuth, companyController.getUserCompanies);
router.get("/companies/:slug", optionalAuth, companyController.getCompany);

// Protected Routes
router.post("/companies", requireAuth, companyController.createCompany);
router.post("/companies/invites/accept", requireAuth, companyController.acceptInvite);
router.post("/companies/:companyId/members/invite", requireAuth, companyController.inviteMember);
router.get("/companies/:companyId/members", requireAuth, companyController.getMembers);
router.delete("/companies/:companyId/members/:memberId", requireAuth, companyController.removeMember);
router.post("/companies/:companyId/leave", requireAuth, companyController.leaveCompany);

router.post("/companies/:companyId/verify/domain", requireAuth, companyController.verifyDomain);
router.post("/companies/:companyId/transfer-ownership", requireAuth, companyController.transferOwnership);
router.put("/companies/:companyId", requireAuth, companyController.updateCompany);
router.delete("/companies/:companyId", requireAuth, companyController.deleteCompany);

module.exports = router;
