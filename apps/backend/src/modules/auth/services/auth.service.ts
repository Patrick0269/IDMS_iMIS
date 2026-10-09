import {
  createSupabaseAuthClient,
  getSupabase,
} from "../../../config/database.js";
import {
  isValidStudentNumber,
  normaliseStudentNumber,
  resolveStudentLoginEmail,
  requestVerifiedPasswordReset as sendVerifiedPasswordReset,
} from "./student-login.service.js";
import { changeAuthenticatedPassword } from "../../../services/password.service.js";
import { escapeIlikeLiteral } from "../../../utils/security.js";
import { randomUUID } from "node:crypto";
import { env } from "../../../config/env.js";
import { createAuditLog } from "../../../services/audit.service.js";
import { sendApplicantVerificationEmail } from "../../../services/email.service.js";

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

  const existing = await db.from("users").select("id").eq("email", email).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) throw Object.assign(new Error("An account already uses this email. Sign in or use account recovery."), { statusCode: 409 });
  const role = await db.from("roles").select("id").eq("role_code", "APPLICANT").eq("status", "ACTIVE").single();
  if (role.error || !role.data) throw new Error("Applicant access is not configured. Contact the Admissions Office.");

  const displayName = [firstName, middleName, lastName].filter(Boolean).join(" ");
  const frontend = env.FRONTEND_URL.replace(/\/+$/, "");
  const generated = await db.auth.admin.generateLink({
    type: "signup", email, password,
    options: { data: { first_name: firstName, middle_name: middleName, last_name: lastName, display_name: displayName }, redirectTo: `${frontend}/applicant-access.html` },
  });
  if (generated.error || !generated.data?.user?.id || !generated.data.properties?.action_link) {
    throw Object.assign(new Error(generated.error?.message || "Unable to create the applicant account."), { statusCode: 400 });
  }

  const authUserId = generated.data.user.id;
  let userId: string | null = null;
  let applicantId: string | null = null;
  try {
    const userNumber = `IDMC/APPLICANT/${new Date().getFullYear()}/${randomUUID().slice(0, 8).toUpperCase()}`;
    const user = await db.from("users").insert({
      auth_user_id: authUserId, user_number: userNumber, first_name: firstName, middle_name: middleName,
      last_name: lastName, display_name: displayName, email, phone: input.phone?.trim() || null, status: "ACTIVE",
    }).select("id").single();
    if (user.error || !user.data) throw user.error || new Error("Unable to create applicant profile.");
    userId = user.data.id;

    const assignment = await db.from("user_roles").insert({ user_id: userId, role_id: role.data.id, status: "ACTIVE" });
    if (assignment.error) throw assignment.error;

    const applicant = await db.from("applicants").insert({
      applicant_number: `APP/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}/${randomUUID().slice(0, 8).toUpperCase()}`,
      first_name: firstName, middle_name: middleName, last_name: lastName, email, phone: input.phone?.trim() || null,
      date_of_birth: input.dateOfBirth || null, gender: input.gender || null, nationality: input.nationality?.trim() || "Tanzanian",
      national_id_number: input.nationalIdNumber?.trim() || null, passport_number: input.passportNumber?.trim() || null,
      applicant_type: "NEW", status: "ACTIVE", auth_user_id: authUserId,
    }).select("id").single();
    if (applicant.error || !applicant.data) throw applicant.error || new Error("Unable to create applicant profile.");
    applicantId = applicant.data.id;

    await createAuditLog({ actorUserId: userId, actionCode: "APPLICANT_ACCOUNT_CREATED", moduleCode: "admissions", entityType: "applicant", entityId: applicantId, newValues: { email, email_verified: false } });
    await sendApplicantVerificationEmail({ recipientEmail: email, recipientName: displayName, actionLink: generated.data.properties.action_link });
    return { verificationRequired: true };
  } catch (error) {
    if (applicantId) await db.from("applicants").delete().eq("id", applicantId);
    if (userId) {
      await db.from("user_roles").delete().eq("user_id", userId).eq("role_id", role.data.id);
      await db.from("users").delete().eq("id", userId);
    }
    await db.auth.admin.deleteUser(authUserId);
    throw error;
  }
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

    const { data: authData, error: authError } =
      await supabase.auth.admin.getUserById(String(emailUser.auth_user_id));

    if (authError || !authData?.user?.email) {
      throw new Error("Invalid login credentials");
    }

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

    const { data: authData, error: authError } =
      await supabase.auth.admin.getUserById(String(usernameUser.auth_user_id));

    if (authError || !authData?.user?.email) {
      throw new Error("Invalid login credentials");
    }

    return String(authData.user.email).trim().toLowerCase();
  }

  throw new Error("Invalid login credentials");
}

export async function login(identifier: string, password: string) {
  if (!String(password ?? "")) {
    throw new Error("Password is required");
  }

  const supabase = getSupabase();
  const authClient = createSupabaseAuthClient();
  const email = await resolveLoginEmail(identifier, String(password));
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
  if (!isValidStudentNumber(number) || !String(password ?? "")) {
    throw new Error("Invalid login credentials");
  }

  const email = await resolveStudentLoginEmail(number, String(password));
  if (!email) {
    throw new Error("Invalid login credentials");
  }

  const supabase = getSupabase();
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password: String(password),
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
  if (!data) throw new Error("IDMC account profile is not linked to this Auth identity.");

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
  if (!user) throw new Error("IDMC user account was not found");

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
        status
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
  for (const role of roles) {
    const { data: rolePermissions, error: permissionError } = await supabase
      .from("role_permissions")
      .select(`
        permissions!inner (
          permission_code,
          status
        )
      `)
      .eq("role_id", role.id);

    if (permissionError) throw permissionError;

    for (const item of rolePermissions ?? []) {
      const permission = item.permissions as any;
      if (permission?.status === "ACTIVE") {
        permissionSet.add(permission.permission_code);
        role.permissions.push(permission.permission_code);
      }
    }
    role.permissions.sort();
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
