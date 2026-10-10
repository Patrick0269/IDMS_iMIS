import type { Request, Response } from "express";
import * as authService from "../services/auth.service.js";
import { logError } from "../../../utils/logger.js";

export async function registerApplicant(req: Request, res: Response): Promise<void> {
  const firstName = String(req.body?.firstName ?? "").trim().slice(0, 100);
  const middleName = String(req.body?.middleName ?? "").trim().slice(0, 100);
  const lastName = String(req.body?.lastName ?? "").trim().slice(0, 100);
  const email = String(req.body?.email ?? "").trim().slice(0, 255);
  const password = String(req.body?.password ?? "");
  if (!firstName || !lastName || !email || !password) {
    res.status(400).json({ success: false, message: "First name, last name, email and password are required." });
    return;
  }
  try {
    const data = await authService.registerApplicant({
      firstName, middleName, lastName, email, password,
      phone: String(req.body?.phone ?? "").trim().slice(0, 50),
      dateOfBirth: String(req.body?.dateOfBirth ?? "").trim().slice(0, 10),
      gender: String(req.body?.gender ?? "").trim().slice(0, 30),
      nationality: String(req.body?.nationality ?? "Tanzanian").trim().slice(0, 100),
      nationalIdNumber: String(req.body?.nationalIdNumber ?? "").trim().slice(0, 100),
      passportNumber: String(req.body?.passportNumber ?? "").trim().slice(0, 100),
    });
    res.status(201).json({ success: true, data, message: data.verificationEmailSent ? "Account created. Check your email to verify the address, then sign in to continue your application." : "Your applicant account was created, but we could not send the verification email. Use Resend verification below; do not submit the registration form again." });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode) || 500;
    if (status >= 500) logError("Applicant account registration failed", error);
    res.status(status).json({ success: false, message: status >= 500 ? "Applicant account could not be created. Please try again or contact Admissions." : (error instanceof Error ? error.message : "Unable to create applicant account.") });
  }
}

export async function resendApplicantVerification(req: Request, res: Response): Promise<void> {
  const email = String(req.body?.email ?? "").trim().slice(0, 255);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    try {
      await authService.resendApplicantVerification(email);
    } catch (error) {
      logError("Applicant verification resend request failed", error);
    }
  }
  res.json({ success: true, message: "If this address has an unverified applicant account, a verification email was requested. Check Inbox and Spam. If it does not arrive, contact Admissions with the request reference." });
}
export async function confirmApplicantVerification(req: Request, res: Response): Promise<void> {
  const tokenHash = String(req.body?.token_hash ?? "").trim();
  const type = String(req.body?.type ?? "signup").trim().toLowerCase();
  if (!tokenHash || tokenHash.length > 512) {
    res.status(400).json({ success: false, message: "This verification link is invalid or has expired. Request a new one." });
    return;
  }
  try {
    const data = await authService.verifyApplicantEmail(tokenHash, type as "signup" | "magiclink");
    res.json({ success: true, data });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode) || 400;
    if (status >= 500) logError("Applicant email confirmation failed", error);
    res.status(status).json({ success: false, message: error instanceof Error ? error.message : "Unable to verify this email address." });
  }
}
export async function login(req: Request, res: Response): Promise<void> {
  const identifier = String(req.body?.identifier ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!identifier || !password) {
    res.status(400).json({
      success: false,
      message: "Email, username or student number and password are required",
    });
    return;
  }

  try {
    const session = await authService.login(identifier, password);
    res.json({ success: true, data: session });
  } catch (error) {
    // The client always sees a generic message (security). The REAL reason
    // (wrong password vs account missing vs Supabase key/config problem) is
    // written to the server logs only, so it can be diagnosed after the fact.
    logError("Staff login failed", error);
    res.status(401).json({
      success: false,
      message: "Invalid login credentials",
    });
  }
}

export async function studentLogin(req: Request, res: Response): Promise<void> {
  const studentNumber = String(req.body?.studentNumber ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!studentNumber || !password) {
    res.status(400).json({
      success: false,
      message: "Student Number and password are required",
    });
    return;
  }

  try {
    const session = await authService.studentLogin(studentNumber, password);
    res.json({ success: true, data: session });
  } catch (error) {
    logError("Student login failed", error);
    res.status(401).json({
      success: false,
      message: "Invalid Student Number or password",
    });
  }
}

export async function requestVerifiedPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    await authService.requestVerifiedPasswordReset({
      accountType: String(req.body?.accountType ?? "").trim().toLowerCase() as "student" | "lecturer",
      email: String(req.body?.email ?? "").trim(),
      registrationNumber: String(req.body?.registrationNumber ?? "").trim(),
      formFourYear: Number(req.body?.formFourYear),
      phone: String(req.body?.phone ?? "").trim(),
    });
  } catch (error) {
    logError("Verified password reset request failed", error);
  }
  res.json({ success: true, message: "Kama taarifa ulizoweka zinaendana na akaunti hai ya IDMC, utapokea link salama ya kubadilisha nenosiri kwenye email yako." });
}

export async function passwordSetupComplete(req: Request, res: Response): Promise<void> {
  if (!req.user?.authUserId) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }
  try {
    const data = await authService.completePasswordSetup(req.user.authUserId);
    res.json({ success: true, data });
  } catch (error) {
    logError("Password setup completion could not be recorded", error);
    res.status(500).json({ success: false, message: "Password was set, but account security history could not be updated. Contact the Registry." });
  }
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  if (!req.user?.authUserId) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  try {
    const data = await authService.changePassword(req.user.authUserId, currentPassword, newPassword, req.ip, req.get("user-agent") || undefined);
    res.json({ success: true, data });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode) || 500;
    if (status >= 500) logError("Authenticated password change failed", error);
    res.status(status).json({ success: false, message: error instanceof Error ? error.message : "Unable to change password." });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return;
  }

  const data = await authService.getCurrentUser(req.user.id);
  const requestedRoleId = req.user.activeRoleId;
  const requestedRole = requestedRoleId ? data.roles.find(role => String(role.id) === String(requestedRoleId)) : undefined;
  if (requestedRoleId && !requestedRole) {
    res.status(403).json({ success: false, code: "ROLE_NOT_ASSIGNED", message: "That role is not currently assigned to this account." });
    return;
  }
  const activeRole = requestedRole || data.roles.find(role => ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"].includes(String(role.roleCode || "").toUpperCase())) || data.roles[0] || null;
  req.user.activeRoleId = activeRole?.id ?? null;
  res.json({ success: true, data: { ...data, activeRoleId: req.user.activeRoleId, mustChangePassword: req.authUser?.mustChangePassword === true } });
}

export async function authHealth(
  _req: Request,
  res: Response
): Promise<void> {
  res.json({
    success: true,
    module: "authentication",
    status: "online",
  });
}
