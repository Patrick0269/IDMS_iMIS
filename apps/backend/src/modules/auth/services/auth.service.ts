import {
  createSupabaseAuthClient,
  getSupabase,
} from "../../../config/database.js";
import {
  isValidStudentNumber,
  normaliseStudentNumber,
  resolveStudentLoginCredentials,
  requestVerifiedPasswordReset as sendVerifiedPasswordReset,
} from "./student-login.service.js";
import { changeAuthenticatedPassword } from "../../../services/password.service.js";
import { escapeIlikeLiteral } from "../../../utils/security.js";
import { randomUUID } from "node:crypto";
import { env } from "../../../config/env.js";
import { createAuditLog } from "../../../services/audit.service.js";
import { sendApplicantVerificationEmail } from "../../../services/email.service.js";
import { getLocalAuthUserById, getLocalAuthUserByEmail, signInLocalAuth, refreshLocalAuthSession, revokeLocalAuthSession, createLocalAuthUser, deleteLocalAuthUser, issueLocalAuthAction, consumeLocalAuthAction, completeLocalPasswordRecovery, createLocalAuthSession } from "../../../services/postgres-auth.service.js";

export async function registerApplicant(input: {
  firstName: string; middleName?: string; lastName: string; email: string; phone?: string;
  dateOfBirth?: string; gender?: string; nationality?: string; nationalIdNumber?: string; passportNumber?: string; password: string;
}) {
  const db = getSupabase();
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const middleName = input.middleName?.trim() || null;
  const lastName = input.lastName.trim();
  const password = input.password;
  if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Enter your first name, last name and a valid email address."), { statusCode: 400 });
  }
  if (password.length < 12 || password.length > 128) {
    throw Object.assign(new Error("Choose a password between 12 and 128 characters."), { statusCode: 400 });
  }
  if (input.dateOfBirth) {
    const birthDate = new Date(`${input.dateOfBirth}T00:00:00Z`);
    const todayParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const today = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== input.dateOfBirth || input.dateOfBirth > today) {
      throw Object.assign(new Error("Enter a valid date of birth that is today or earlier."), { statusCode: 400 });
    }
  }

  const existing = await db.from("users").select("id").eq("email", email).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) throw Object.assign(new Error("An account already uses this email. Sign in or use account recovery."), { statusCode: 409 });
  if (env.AUTH_PROVIDER === "postgres") {
    // A restored/migrated auth identity can exist without its public IDMS profile.
    // Do not attempt to recreate that unique email identity or overwrite its password;
    // direct the operator to reconcile the missing profile instead.
    const existingIdentity = await getLocalAuthUserByEmail(email);
    if (existingIdentity) {
      throw Object.assign(
        new Error("A sign-in identity already exists for this email, but its IDMS applicant profile is missing. Contact Admissions or ICT to restore the existing profile; do not register again."),
        { statusCode: 409 },
      );
    }
  }
  const role = await db.from("roles").select("id").eq("role_code", "APPLICANT").eq("status", "ACTIVE").single();
  if (role.error || !role.data) throw new Error("Applicant access is not configured. Contact the Admissions Office.");

  const displayName = [firstName, middleName, lastName].filter(Boolean).join(" ");
  const frontend = env.FRONTEND_URL.replace(/\/+$/, "");
  const userMetadata = { first_name: firstName, middle_name: middleName, last_name: lastName, display_name: displayName };
  let authUserId: string;
  let verificationToken: string;
  if (env.AUTH_PROVIDER === "postgres") {
    authUserId = randomUUID();
    try {
      await createLocalAuthUser({ id: authUserId, email, password, userMetadata, appMetadata: {}, emailConfirmed: false });
      verificationToken = await issueLocalAuthAction(authUserId, "signup");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "23505") {
        throw Object.assign(new Error("An account already uses this email. Sign in or use account recovery."), { statusCode: 409 });
      }
      throw Object.assign(error instanceof Error ? error : new Error("Unable to create the applicant account."), { statusCode: 503 });
    }
  } else {
    const generated = await db.auth.admin.generateLink({
      type: "signup", email, password,
      options: { data: userMetadata, redirectTo: frontend + "/applicant-access.html" },
    });
    if (generated.error || !generated.data?.user?.id || !generated.data.properties?.hashed_token) {
      throw Object.assign(new Error(generated.error?.message || "Unable to create the applicant account."), { statusCode: 400 });
    }
    authUserId = generated.data.user.id;
    verificationToken = generated.data.properties.hashed_token;
  }
  let userId: string | null = null;
  let applicantId: string | null = null;
  try {
    const userNumber = "IDMC/APPLICANT/" + new Date().getFullYear() + "/" + randomUUID().slice(0, 8).toUpperCase();
    const user = await db.from("users").insert({
      auth_user_id: authUserId, user_number: userNumber, first_name: firstName, middle_name: middleName,
      last_name: lastName, display_name: displayName, email, phone: input.phone?.trim() || null, status: "ACTIVE",
    }).select("id").single();
    if (user.error || !user.data) throw user.error || new Error("Unable to create applicant profile.");
    userId = user.data.id;

    const assignment = await db.from("user_roles").insert({ user_id: userId, role_id: role.data.id, status: "ACTIVE" });
    if (assignment.error) throw assignment.error;

    const applicant = await db.from("applicants").insert({
      applicant_number: "APP/" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "/" + randomUUID().slice(0, 8).toUpperCase(),
      first_name: firstName, middle_name: middleName, last_name: lastName, email, phone: input.phone?.trim() || null,
      date_of_birth: input.dateOfBirth || null, gender: input.gender || null, nationality: input.nationality?.trim() || "Tanzanian",
      national_id_number: input.nationalIdNumber?.trim() || null, passport_number: input.passportNumber?.trim() || null,
      applicant_type: "NEW", status: "ACTIVE", auth_user_id: authUserId,
    }).select("id").single();
    if (applicant.error || !applicant.data) throw applicant.error || new Error("Unable to create applicant profile.");
    applicantId = applicant.data.id;

    await createAuditLog({ actorUserId: userId, actionCode: "APPLICANT_ACCOUNT_CREATED", moduleCode: "admissions", entityType: "applicant", entityId: applicantId, newValues: { email, email_verified: false } });
  } catch (error) {
    if (applicantId) await db.from("applicants").delete().eq("id", applicantId);
    if (userId) {
      await db.from("user_roles").delete().eq("user_id", userId).eq("role_id", role.data.id);
      await db.from("users").delete().eq("id", userId);
    }
    if (env.AUTH_PROVIDER === "postgres") await deleteLocalAuthUser(authUserId);
    else await db.auth.admin.deleteUser(authUserId);
    throw error;
  }

  let verificationEmailSent = false;
  try {
    const verifyUrl = new URL(`${frontend}/applicant-access.html`);
    verifyUrl.searchParams.set("token_hash", verificationToken);
    verifyUrl.searchParams.set("type", "signup");
    await sendApplicantVerificationEmail({ recipientEmail: email, recipientName: displayName, actionLink: verifyUrl.toString() });
    verificationEmailSent = true;
  } catch (smtpError) {
    try {
      if (env.AUTH_PROVIDER === "postgres") throw smtpError;
      const resend = await db.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: frontend + "/applicant-access.html" },
      });
      if (resend.error) throw resend.error;
      verificationEmailSent = true;
    } catch (fallbackError) {
      const errorCode = (error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error) return String((error as { code: unknown }).code).slice(0, 40);
        return error instanceof Error ? error.name : "unknown";
      };
      console.warn("Applicant verification delivery failed through Worker SMTP and Supabase Auth fallback.", {
        smtpCode: errorCode(smtpError), fallbackCode: errorCode(fallbackError),
      });
    }
  }
  return { verificationRequired: true, verificationEmailSent };
}

export async function resendApplicantVerification(email: string): Promise<boolean> {
  const db = getSupabase();
  const normalizedEmail = email.trim().toLowerCase();
  const { data: profile, error: profileError } = await db.from("users")
    .select("id,auth_user_id,status,display_name,first_name,last_name,email")
    .ilike("email", normalizedEmail)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.status !== "ACTIVE" || !profile.auth_user_id) return false;

  const { data: assignments, error: rolesError } = await db.from("user_roles")
    .select("roles(role_code)")
    .eq("user_id", profile.id)
    .eq("status", "ACTIVE");
  if (rolesError) throw rolesError;
  if (!(assignments || []).some((assignment: any) => String(assignment.roles?.role_code || "").toUpperCase() === "APPLICANT")) return false;

  const identity = env.AUTH_PROVIDER === "postgres"
    ? await getLocalAuthUserById(String(profile.auth_user_id))
    : (await db.auth.admin.getUserById(String(profile.auth_user_id))).data?.user;
  if (!identity || String(identity.email ?? "").trim().toLowerCase() !== normalizedEmail || Boolean(identity.email_confirmed_at)) return false;

  // Generate a one-time sign-in/verification token server-side and deliver it
  // through the same Worker SMTP transport used by password recovery.
  const frontend = env.FRONTEND_URL.replace(/\/+$/, "");
  const generated = env.AUTH_PROVIDER === "postgres" ? null : await db.auth.admin.generateLink({ type: "magiclink", email: normalizedEmail });
  const tokenHash = env.AUTH_PROVIDER === "postgres"
    ? await issueLocalAuthAction(String(profile.auth_user_id), "magiclink")
    : generated?.data?.properties?.hashed_token;
  if (!tokenHash || generated?.error) throw generated?.error ?? new Error("Unable to create applicant verification link.");

  const verifyUrl = new URL(`${frontend}/applicant-access.html`);
  verifyUrl.searchParams.set("token_hash", tokenHash);
  verifyUrl.searchParams.set("type", "magiclink");
  const recipientName = String(profile.display_name || [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Applicant");
  try {
    await sendApplicantVerificationEmail({ recipientEmail: normalizedEmail, recipientName, actionLink: verifyUrl.toString() });
    return true;
  } catch (smtpError) {
    // Supabase Auth SMTP is a separate fallback provider. Keep it as a fallback
    // so an SMTP outage in either service does not make resend impossible.
    if (env.AUTH_PROVIDER === "postgres") throw smtpError;
    const { error } = await db.auth.resend({
      type: "signup",
      email: normalizedEmail,
      options: { emailRedirectTo: `${frontend}/applicant-access.html` },
    });
    if (error) throw new AggregateError([smtpError, error], "Applicant verification delivery failed through both email providers.");
    return true;
  }
}

export async function verifyApplicantEmail(tokenHash: string, type: "signup" | "magiclink" = "signup") {
  if (!tokenHash || tokenHash.length > 512) throw Object.assign(new Error("This verification link is invalid or has expired. Request a new one."), { statusCode: 400 });
  if (type !== "signup" && type !== "magiclink") throw Object.assign(new Error("This verification link is invalid or has expired. Request a new one."), { statusCode: 400 });
  if (env.AUTH_PROVIDER === "postgres") {
    const user = await consumeLocalAuthAction(tokenHash, type);
    if (!user) throw Object.assign(new Error("This verification link is invalid or has expired. Request a new one."), { statusCode: 400 });
    const db = getSupabase();
    const profile = await db.from("users").select("id,status").eq("auth_user_id", user.id).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data || profile.data.status !== "ACTIVE") throw Object.assign(new Error("Applicant access is not available for this account."), { statusCode: 403 });
    const assignments = await db.from("user_roles").select("roles(role_code)").eq("user_id", profile.data.id).eq("status", "ACTIVE");
    if (assignments.error) throw assignments.error;
    if (!(assignments.data || []).some((assignment: any) => String(assignment.roles?.role_code || "").toUpperCase() === "APPLICANT")) throw Object.assign(new Error("Applicant access is not available for this account."), { statusCode: 403 });
    return createLocalAuthSession(user);
  }
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error || !data.session || !data.user) throw Object.assign(new Error("This verification link is invalid or has expired. Request a new one."), { statusCode: 400 });

  const db = getSupabase();
  const { data: user, error: userError } = await db.from("users").select("id,status").eq("auth_user_id", data.user.id).maybeSingle();
  if (userError) throw userError;
  if (!user || user.status !== "ACTIVE") throw Object.assign(new Error("Applicant access is not available for this account."), { statusCode: 403 });
  const { data: assignments, error: rolesError } = await db.from("user_roles").select("roles(role_code)").eq("user_id", user.id).eq("status", "ACTIVE");
  if (rolesError) throw rolesError;
  const hasApplicantRole = (assignments || []).some((assignment: any) => String(assignment.roles?.role_code || "").toUpperCase() === "APPLICANT");
  if (!hasApplicantRole) throw Object.assign(new Error("Applicant access is not available for this account."), { statusCode: 403 });
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    expires_in: data.session.expires_in,
    token_type: data.session.token_type,
  };
}
function normaliseIdentifier(value: string): string {
  return String(value ?? "").trim();
}

async function resolveLoginEmail(
  identifier: string,
  password = ""
): Promise<string> {
  const supabase = getSupabase();
  const value = normaliseIdentifier(identifier);

  if (!value) {
    throw new Error("Email, username or student number is required");
  }

  /* Resolve staff email through public.users so the application profile
   * and Supabase Auth identity cannot silently drift apart. */
  if (value.includes("@")) {
    const { data: emailUser, error: emailError } = await supabase
      .from("users")
      .select("id, auth_user_id, email, status")
      .ilike("email", escapeIlikeLiteral(value))
      .maybeSingle();

    if (emailError) throw emailError;
    if (!emailUser || emailUser.status !== "ACTIVE") {
      throw new Error("Invalid login credentials");
    }

    if (env.AUTH_PROVIDER === "postgres") {
      const authUser = await getLocalAuthUserById(String(emailUser.auth_user_id));
      if (!authUser?.email) throw new Error("Invalid login credentials");
      return authUser.email.trim().toLowerCase();
    }
    const { data: authData, error: authError } = await supabase.auth.admin.getUserById(String(emailUser.auth_user_id));
    if (authError || !authData?.user?.email) throw new Error("Invalid login credentials");
    return String(authData.user.email).trim().toLowerCase();
  }

  const { data: usernameUser, error: usernameError } = await supabase
    .from("users")
    .select("id, auth_user_id, email, status")
    .ilike("username", escapeIlikeLiteral(value))
    .maybeSingle();

  if (usernameError) throw usernameError;

  if (usernameUser) {
    if (usernameUser.status !== "ACTIVE") {
      throw new Error(`User account is ${usernameUser.status}`);
    }

    if (env.AUTH_PROVIDER === "postgres") {
      const authUser = await getLocalAuthUserById(String(usernameUser.auth_user_id));
      if (!authUser?.email) throw new Error("Invalid login credentials");
      return authUser.email.trim().toLowerCase();
    }
    const { data: authData, error: authError } = await supabase.auth.admin.getUserById(String(usernameUser.auth_user_id));
    if (authError || !authData?.user?.email) throw new Error("Invalid login credentials");
    return String(authData.user.email).trim().toLowerCase();
  }

  throw new Error("Invalid login credentials");
}

export async function login(identifier: string, password: string) {
  if (!String(password ?? "")) {
    throw new Error("Password is required");
  }

  const supabase = getSupabase();
  const email = await resolveLoginEmail(identifier, String(password));
  if (env.AUTH_PROVIDER === "postgres") {
    const session = await signInLocalAuth(email, String(password));
    const { error: lastLoginError } = await supabase.from("users").update({ last_login_at: new Date().toISOString() }).eq("email", email);
    if (lastLoginError) console.warn("Unable to update last_login_at", lastLoginError.message);
    return session;
  }
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password: String(password),
  });

  if (error || !data.session) {
    throw new Error("Invalid login credentials");
  }

  // Keep the portal's Last Login information current without blocking sign-in
  // if the audit timestamp cannot be written.
  const { error: lastLoginError } = await supabase
    .from("users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("auth_user_id", data.user.id);
  if (lastLoginError) {
    console.warn("Unable to update last_login_at", lastLoginError.message);
  }

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    expires_in: data.session.expires_in,
    token_type: data.session.token_type,
  };
}

export async function studentLogin(studentNumber: string, password: string) {
  const number = normaliseStudentNumber(studentNumber);
  const suppliedPassword = String(password ?? "");
  if (!isValidStudentNumber(number) || !suppliedPassword) {
    throw new Error("Invalid login credentials");
  }

  const credentials = await resolveStudentLoginCredentials(number, suppliedPassword);
  if (!credentials) {
    throw new Error("Invalid login credentials");
  }
  const { email, password: passwordToCheck } = credentials;

  const supabase = getSupabase();
  if (env.AUTH_PROVIDER === "postgres") {
    const session = await signInLocalAuth(email, passwordToCheck);
    const { error: lastLoginError } = await supabase.from("users").update({ last_login_at: new Date().toISOString() }).ilike("email", escapeIlikeLiteral(email));
    if (lastLoginError) console.warn("Unable to update last_login_at", lastLoginError.message);
    return session;
  }
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password: passwordToCheck,
  });

  if (error || !data.session) {
    throw new Error("Invalid login credentials");
  }

  const { error: lastLoginError } = await supabase
    .from("users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("auth_user_id", data.user.id);
  if (lastLoginError) {
    console.warn("Unable to update last_login_at", lastLoginError.message);
  }

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    expires_in: data.session.expires_in,
    token_type: data.session.token_type,
  };
}

export async function refreshSession(refreshToken: string) {
  if (env.AUTH_PROVIDER === "postgres") return refreshLocalAuthSession(refreshToken);
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw new Error("Invalid or expired refresh token");
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at, expires_in: data.session.expires_in, token_type: data.session.token_type };
}

export async function logoutSession(refreshToken: string, accessToken?: string) {
  if (env.AUTH_PROVIDER === "postgres") return revokeLocalAuthSession(refreshToken);
  if (!accessToken) return;
  const authClient = createSupabaseAuthClient();
  await authClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken || "" });
  await authClient.auth.signOut();
}

export async function completePasswordRecovery(token: string, password: string) {
  if (env.AUTH_PROVIDER === "postgres") return completeLocalPasswordRecovery(token, password);
  throw Object.assign(new Error("Complete password recovery through the secure email link."), { statusCode: 400 });
}

export async function requestVerifiedPasswordReset(input: Parameters<typeof sendVerifiedPasswordReset>[0]) {
  return sendVerifiedPasswordReset(input);
}

export async function completePasswordSetup(authUserId: string) {
  const supabase = getSupabase();
  const changedAt = new Date().toISOString();
  const { data, error } = await supabase.from("users")
    .update({ password_changed_at: changedAt, updated_at: changedAt })
    .eq("auth_user_id", authUserId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("IDMS account profile is not linked to this Auth identity.");

  const { error: logError } = await supabase.from("security_logs").insert({
    user_id: data.id,
    event_code: "PASSWORD_SETUP_COMPLETED",
    success: true,
    details: { source: "secure-setup-link" },
  });
  if (logError) console.warn("Password setup completed but security history was not recorded.");
  return { changed: true, passwordChangedAt: changedAt };
}

export async function changePassword(authUserId: string, currentPassword: string, newPassword: string, ipAddress?: string, userAgent?: string) {
  return changeAuthenticatedPassword(authUserId, currentPassword, newPassword, {
    ipAddress,
    userAgent,
    source: "authenticated-account",
  });
}

export async function getCurrentUser(userId: string) {
  const supabase = getSupabase();

  const { data: user, error: userError } = await supabase
    .from("users")
    .select(`
      id,
      auth_user_id,
      user_number,
      username,
      first_name,
      middle_name,
      last_name,
      display_name,
      email,
      phone,
      profile_photo_url,
      status,
      last_login_at,
      password_changed_at,
      email_verified_at,
      phone_verified_at,
      created_at,
      updated_at
    `)
    .eq("id", userId)
    .maybeSingle();

  if (userError) throw userError;
  if (!user) throw new Error("IDMS user account was not found");

  const { data: userRoles, error: rolesError } = await supabase
    .from("user_roles")
    .select(`
      id,
      role_id,
      status,
      assigned_at,
      expires_at,
      roles!inner (
        id,
        role_code,
        role_name,
        description,
        status,
        role_permissions (
          permissions!inner ( permission_code, status )
        )
      )
    `)
    .eq("user_id", userId)
    .eq("status", "ACTIVE");

  if (rolesError) throw rolesError;

  const now = new Date();
  const roles = (userRoles ?? [])
    .filter((item: any) =>
      item.status === "ACTIVE" &&
      item.roles?.status === "ACTIVE" &&
      (!item.expires_at || new Date(item.expires_at) > now)
    )
    .map((item: any) => ({
      id: item.roles.id,
      roleCode: item.roles.role_code,
      roleName: item.roles.role_name,
      description: item.roles.description,
      assignedAt: item.assigned_at,
      expiresAt: item.expires_at,
      permissions: [] as string[],
    }));

  const permissionSet = new Set<string>();
  for (const item of userRoles ?? []) {
    const role = roles.find((candidate: any) => String(candidate.id) === String(item.role_id));
    if (!role) continue;
    for (const link of (item.roles as any)?.role_permissions ?? []) {
      const permission = link.permissions as any;
      if (permission?.status === "ACTIVE" && permission.permission_code) {
        permissionSet.add(permission.permission_code);
        role.permissions.push(permission.permission_code);
      }
    }
    role.permissions = Array.from(new Set(role.permissions)).sort();
  }

  const staffProfile = await supabase
    .from("staff")
    .select("profile_photo_url,employee_number,department_id,departments(department_name)")
    .eq("user_id", user.id)
    .maybeSingle();
  if (staffProfile.error) throw staffProfile.error;
  const department = staffProfile.data?.departments as { department_name?: string } | null;
  return {
    user: {
      id: user.id,
      authUserId: user.auth_user_id,
      userNumber: user.user_number,
      username: user.username,
      firstName: user.first_name,
      middleName: user.middle_name,
      lastName: user.last_name,
      displayName: user.display_name,
      email: user.email,
      phone: user.phone,
      profilePhotoUrl: staffProfile.data?.profile_photo_url || user.profile_photo_url,
      staffNumber: staffProfile.data?.employee_number || null,
      departmentName: department?.department_name || null,
      status: user.status,
      lastLoginAt: user.last_login_at,
      passwordChangedAt: user.password_changed_at,
      emailVerifiedAt: user.email_verified_at,
      phoneVerifiedAt: user.phone_verified_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    },
    roles,
    permissions: Array.from(permissionSet).sort(),
    staffProfile: staffProfile.data ? {
      employeeNumber: staffProfile.data.employee_number || null,
      departmentName: department?.department_name || null,
      departmentId: staffProfile.data.department_id || null,
      profilePhotoUrl: staffProfile.data.profile_photo_url || user.profile_photo_url || null,
    } : null,
  };
}

export async function getUserByAuthUserId(authUserId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("users")
    .select(`
      id,
      auth_user_id,
      user_number,
      username,
      first_name,
      middle_name,
      last_name,
      display_name,
      email,
      phone,
      status,
      created_at,
      updated_at
    `)
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) throw error;
  return data;
}
