import { randomBytes, randomUUID } from "node:crypto";
import type { TokenPayload } from "google-auth-library";
import { getSupabase } from "../../../config/database.js";
import { env } from "../../../config/env.js";
import { createAuditLog } from "../../../services/audit.service.js";
import {
  createLocalAuthSession,
  createLocalAuthUser,
  deleteLocalAuthUser,
  getLocalAuthUserByEmail,
  getLocalAuthUserById,
  type LocalAuthUser,
} from "../../../services/postgres-auth.service.js";

function requiredGoogleConfig() {
  if (env.AUTH_PROVIDER !== "postgres") throw Object.assign(new Error("Google Applicant Sign-In is available only with PostgreSQL Auth."), { statusCode: 503 });
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) {
    throw Object.assign(new Error("Google Applicant Sign-In has not been configured by the system administrator."), { statusCode: 503 });
  }
  const redirect = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
  if (env.NODE_ENV === "production" && redirect.protocol !== "https:") {
    throw Object.assign(new Error("Google sign-in requires an HTTPS callback in production."), { statusCode: 503 });
  }
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: redirect.toString() };
}

export function getGoogleApplicantOAuthConfig() {
  return requiredGoogleConfig();
}

function googleName(payload: TokenPayload): { firstName: string; middleName: string | null; lastName: string } {
  const full = String(payload.name || "").trim().split(/\s+/).filter(Boolean);
  const given = String(payload.given_name || "").trim().split(/\s+/).filter(Boolean);
  const firstName = given[0] || full[0] || "";
  const lastName = String(payload.family_name || "").trim() || (full.length > 1 ? full[full.length - 1] : "");
  const middleName = given.length > 1 ? given.slice(1).join(" ") : (full.length > 2 ? full.slice(1, -1).join(" ") : null);
  if (!firstName || !lastName) throw Object.assign(new Error("Your Google profile must include your first and last name. Update it and try again."), { statusCode: 400 });
  return { firstName: firstName.slice(0, 100), middleName: middleName?.slice(0, 100) || null, lastName: lastName.slice(0, 100) };
}

async function createApplicantProfile(authUserId: string, email: string, name: ReturnType<typeof googleName>) {
  const db = getSupabase();
  const existingProfile = await db.from("users").select("id,auth_user_id").eq("email", email).maybeSingle();
  if (existingProfile.error) throw existingProfile.error;
  if (existingProfile.data && existingProfile.data.auth_user_id !== authUserId) {
    throw Object.assign(new Error("An IDMS account already uses this email. Sign in to that account first or contact Admissions to link it safely."), { statusCode: 409 });
  }
  if (existingProfile.data) return existingProfile.data.id as string;

  const role = await db.from("roles").select("id").eq("role_code", "APPLICANT").eq("status", "ACTIVE").single();
  if (role.error || !role.data) throw Object.assign(new Error("Applicant access is not configured. Contact Admissions."), { statusCode: 503 });
  const displayName = [name.firstName, name.middleName, name.lastName].filter(Boolean).join(" ");
  let userId: string | null = null;
  let applicantId: string | null = null;
  try {
    const user = await db.from("users").insert({
      auth_user_id: authUserId,
      user_number: `IDMC/APPLICANT/${new Date().getFullYear()}/${randomUUID().slice(0, 8).toUpperCase()}`,
      first_name: name.firstName, middle_name: name.middleName, last_name: name.lastName,
      display_name: displayName, email, status: "ACTIVE", email_verified_at: new Date().toISOString(),
    }).select("id").single();
    if (user.error || !user.data) throw user.error || new Error("Unable to create Applicant account profile.");
    userId = user.data.id;
    const assignment = await db.from("user_roles").insert({ user_id: userId, role_id: role.data.id, status: "ACTIVE" });
    if (assignment.error) throw assignment.error;
    const applicant = await db.from("applicants").insert({
      applicant_number: `APP/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}/${randomUUID().slice(0, 8).toUpperCase()}`,
      first_name: name.firstName, middle_name: name.middleName, last_name: name.lastName,
      email, nationality: "Tanzanian", applicant_type: "NEW", status: "ACTIVE", auth_user_id: authUserId,
    }).select("id").single();
    if (applicant.error || !applicant.data) throw applicant.error || new Error("Unable to create Applicant account.");
    applicantId = applicant.data.id;
    await createAuditLog({ actorUserId: userId, actionCode: "APPLICANT_ACCOUNT_CREATED", moduleCode: "admissions", entityType: "applicant", entityId: applicantId, newValues: { email, email_verified: true, identity_provider: "google" } });
    return userId;
  } catch (error) {
    if (applicantId) await db.from("applicants").delete().eq("id", applicantId);
    if (userId) {
      await db.from("user_roles").delete().eq("user_id", userId).eq("role_id", role.data.id);
      await db.from("users").delete().eq("id", userId);
    }
    throw error;
  }
}

export async function finishGoogleApplicantLogin(payload: TokenPayload) {
  requiredGoogleConfig();
  const email = String(payload.email || "").trim().toLowerCase();
  const googleSub = String(payload.sub || "");
  if (payload.email_verified !== true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !googleSub) {
    throw Object.assign(new Error("Google did not provide a verified email address. Use Applicant email registration instead."), { statusCode: 403 });
  }
  const name = googleName(payload);
  const identity = await getLocalAuthUserByEmail(email);
  let authUser: LocalAuthUser;
  let isNewApplicant = false;
  if (identity) {
    const metadata = identity.raw_app_meta_data || {};
    if (metadata.provider !== "google" || metadata.google_sub !== googleSub) {
      throw Object.assign(new Error("An IDMS account already uses this email. Sign in to that account first or contact Admissions to link it safely."), { statusCode: 409 });
    }
    if (!identity.email_confirmed_at || identity.deleted_at || (identity.banned_until && new Date(identity.banned_until).getTime() > Date.now())) {
      throw Object.assign(new Error("This Google-linked IDMS account is not available. Contact Admissions or ICT."), { statusCode: 403 });
    }
    authUser = identity;
  } else {
    const authUserId = randomUUID();
    authUser = await createLocalAuthUser({
      id: authUserId,
      email,
      // A random password is never shown or used; the account authenticates through its verified Google identity.
      password: randomBytes(48).toString("base64url"),
      emailConfirmed: true,
      userMetadata: { first_name: name.firstName, middle_name: name.middleName, last_name: name.lastName, display_name: [name.firstName, name.middleName, name.lastName].filter(Boolean).join(" ") },
      appMetadata: { provider: "google", google_sub: googleSub },
    });
    isNewApplicant = true;
  }
  let profileReady = false;
  try {
    const profileId = await createApplicantProfile(authUser.id, email, name);
    profileReady = true;
    const profile = await getSupabase().from("users").select("id,auth_user_id,status").eq("id", profileId).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data || profile.data.auth_user_id !== authUser.id || profile.data.status !== "ACTIVE") throw Object.assign(new Error("Applicant account is not active."), { statusCode: 403 });
    const assignments = await getSupabase().from("user_roles").select("roles(role_code)").eq("user_id", profileId).eq("status", "ACTIVE");
    if (assignments.error) throw assignments.error;
    if (!(assignments.data || []).some((row: any) => String(row.roles?.role_code || "").toUpperCase() === "APPLICANT")) throw Object.assign(new Error("This IDMS identity is not an applicant account."), { statusCode: 403 });
    return { session: await createLocalAuthSession(authUser), isNewApplicant };
  } catch (error) {
    if (isNewApplicant && !profileReady) await deleteLocalAuthUser(authUser.id).catch(() => undefined);
    throw error;
  }
}
