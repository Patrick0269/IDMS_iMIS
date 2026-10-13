import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import * as authService from "../services/auth.service.js";
import { finishGoogleApplicantLogin, getGoogleApplicantOAuthConfig } from "../services/google-applicant-auth.service.js";
import { env } from "../../../config/env.js";
import { logError } from "../../../utils/logger.js";
import { randomBytes } from "node:crypto";

const OAUTH_COOKIE_OPTIONS = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/api/v1/auth", maxAge: 10 * 60 * 1000 };
function readCookie(req: Request, name: string): string | null {
  const prefix = `${name}=`;
  const item = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(prefix.length)); } catch { return null; }
}
function applicantAccessUrl() { return new URL("applicant-access.html", `${env.FRONTEND_URL.replace(/\/+$/, "")}/`).toString(); }

export function googleApplicantStart(_req: Request, res: Response): void {
  try {
    const config = getGoogleApplicantOAuthConfig();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    res.cookie("idmc_google_state", state, OAUTH_COOKIE_OPTIONS);
    res.cookie("idmc_google_nonce", nonce, OAUTH_COOKIE_OPTIONS);
    const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    res.redirect(client.generateAuthUrl({ response_type: "code", scope: ["openid", "email", "profile"], state, nonce, prompt: "select_account" }));
  } catch (error) {
    logError("Google Applicant Sign-In could not start", error);
    const target = new URL(applicantAccessUrl()); target.searchParams.set("google_error", "unavailable");
    res.redirect(target.toString());
  }
}

export async function googleApplicantCallback(req: Request, res: Response): Promise<void> {
  const clearCookies = () => {
    const options = { ...OAUTH_COOKIE_OPTIONS, maxAge: 0 };
    res.cookie("idmc_google_state", "", options);
    res.cookie("idmc_google_nonce", "", options);
  };
  const fail = (code: string) => { clearCookies(); const target = new URL(applicantAccessUrl()); target.searchParams.set("google_error", code); res.redirect(target.toString()); };
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const expectedState = readCookie(req, "idmc_google_state");
  const expectedNonce = readCookie(req, "idmc_google_nonce");
  if (req.query.error || !state || !expectedState || state !== expectedState || !expectedNonce || !code) { fail(req.query.error === "access_denied" ? "cancelled" : "invalid"); return; }
  try {
    const config = getGoogleApplicantOAuthConfig();
    const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    const tokenResponse = await client.getToken(code);
    const idToken = tokenResponse.tokens.id_token;
    if (!idToken) throw new Error("Google OAuth response did not contain an ID token.");
    const ticket = await client.verifyIdToken({ idToken, audience: config.clientId });
    const payload = ticket.getPayload();
    if (!payload || payload.nonce !== expectedNonce) throw Object.assign(new Error("Google identity nonce did not match the authentication request."), { statusCode: 401 });
    const result = await finishGoogleApplicantLogin(payload);
    clearCookies();
    const session = result.session;
    const fragment = new URLSearchParams({ access_token: session.access_token, refresh_token: session.refresh_token || "", expires_in: String(session.expires_in || ""), expires_at: String(session.expires_at || ""), token_type: session.token_type || "bearer", type: "google", new_applicant: result.isNewApplicant ? "1" : "0" });
    res.redirect(`${applicantAccessUrl()}#${fragment.toString()}`);
  } catch (error) {
    logError("Google Applicant Sign-In failed", error);
    const status = Number((error as { statusCode?: number })?.statusCode);
    fail(status === 409 ? "account_exists" : status === 503 ? "unavailable" : "failed");
  }
}

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
    const invalidCredentials = error instanceof Error && error.message === "Invalid login credentials";
    res.status(invalidCredentials ? 401 : 503).json({
      success: false,
      message: invalidCredentials ? "Invalid Student Number or password" : "Student sign-in is temporarily unavailable. Please try again shortly.",
      ...(!invalidCredentials && req.requestId ? { requestId: req.requestId } : {}),
    });
  }
}

export async function refreshSession(req: Request, res: Response): Promise<void> {
  const refreshToken = String(req.body?.refresh_token ?? "");
  if (!refreshToken || refreshToken.length > 256) {
    res.status(401).json({ success: false, message: "Session expired. Sign in again." });
    return;
  }
  try {
    res.json({ success: true, data: await authService.refreshSession(refreshToken) });
  } catch {
    res.status(401).json({ success: false, message: "Session expired. Sign in again." });
  }
}

export async function logoutSession(req: Request, res: Response): Promise<void> {
  const refreshToken = String(req.body?.refresh_token ?? "");
  const authorization = String(req.headers.authorization ?? "");
  const accessToken = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  try { await authService.logoutSession(refreshToken, accessToken); }
  catch (error) { logError("Logout session revocation failed", error); }
  res.json({ success: true });
}

export async function completePasswordRecovery(req: Request, res: Response): Promise<void> {
  const token = String(req.body?.token_hash ?? "");
  const password = String(req.body?.password ?? "");
  try {
    const changed = await authService.completePasswordRecovery(token, password);
    if (!changed) {
      res.status(400).json({ success: false, message: "This recovery link is invalid or expired. Request a new one." });
      return;
    }
    res.json({ success: true, message: "Password changed. You can now sign in." });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode) || 400;
    res.status(status).json({ success: false, message: error instanceof Error ? error.message : "Unable to change password." });
  }
}

export async function requestVerifiedPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    await authService.requestVerifiedPasswordReset({
      accountType: String(req.body?.accountType ?? "").trim().toLowerCase() as "student" | "lecturer" | "applicant",
      email: String(req.body?.email ?? "").trim(),
      registrationNumber: String(req.body?.registrationNumber ?? "").trim(),
      birthYear: Number(req.body?.birthYear),
      phone: String(req.body?.phone ?? "").trim(),
    });
  } catch (error) {
    logError("Verified password reset request failed", error);
  }
  res.json({ success: true, message: "If the details match an active account, a secure password-reset link will be sent to the registered email address. Check Inbox and Spam/Junk." });
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

  // First-login students only need the gate state to enter the password form.
  // Avoid loading the full staff profile and nested role-permission graph here;
  // that work is unnecessary while the account is restricted and can make the
  // first-login screen appear to hang on slow mobile connections.
  if (req.authUser?.mustChangePassword) {
    res.json({ success: true, data: {
      id: req.user.id,
      userNumber: req.user.userNumber,
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      status: req.user.status,
      roles: [],
      permissions: [],
      activeRoleId: null,
      mustChangePassword: true,
    } });
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
