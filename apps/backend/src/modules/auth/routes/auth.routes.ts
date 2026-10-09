import { Router } from "express";
import * as controller from "../controllers/auth.controller.js";
import { authenticate } from "../../../middleware/auth.js";
import { rateLimit } from "../../../middleware/rateLimit.js";

const router = Router();

router.get("/health", controller.authHealth);
router.post("/applicant-register", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: "applicant-register" }), controller.registerApplicant);
router.post("/student-login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: "student-login" }), controller.studentLogin);
router.post("/password-reset", rateLimit({ windowMs: 15 * 60 * 1000, max: 3, name: "verified-password-reset" }), controller.requestVerifiedPasswordReset);
router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: "auth-login" }), controller.login);
router.get("/me", authenticate, controller.me);
router.post("/password-setup-complete", authenticate, controller.passwordSetupComplete);
router.post("/change-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: "password-change" }), authenticate, controller.changePassword);

export default router;
