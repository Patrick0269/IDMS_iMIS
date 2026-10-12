import { Router } from "express";
import * as controller from "../controllers/auth.controller.js";
import { authenticate } from "../../../middleware/auth.js";
import { rateLimit } from "../../../middleware/rateLimit.js";

const router = Router();

router.get("/health", controller.authHealth);
router.post("/applicant-register", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: "applicant-register" }), controller.registerApplicant);
router.post("/applicant-verification-resend", rateLimit({ windowMs: 60 * 60 * 1000, max: 3, name: "applicant-verification-resend" }), controller.resendApplicantVerification);
router.post("/applicant-verification-confirm", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: "applicant-verification-confirm" }), controller.confirmApplicantVerification);
router.post("/student-login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: "student-login" }), controller.studentLogin);
router.post("/refresh", rateLimit({ windowMs: 15 * 60 * 1000, max: 30, name: "auth-refresh" }), controller.refreshSession);
router.post("/logout", controller.logoutSession);
router.post("/password-recovery-complete", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: "password-recovery-complete" }), controller.completePasswordRecovery);
router.post("/password-reset", rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 3, name: "verified-password-reset", keyGenerator: req => String(req.body?.registrationNumber || req.body?.email || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80) }), controller.requestVerifiedPasswordReset);
router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: "auth-login" }), controller.login);
router.get("/me", authenticate, controller.me);
router.post("/password-setup-complete", authenticate, controller.passwordSetupComplete);
router.post("/change-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: "password-change" }), authenticate, controller.changePassword);

export default router;
