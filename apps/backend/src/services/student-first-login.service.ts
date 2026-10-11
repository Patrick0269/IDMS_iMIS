import { getSupabase } from "../config/database.js";

export function studentInitialNumber(student: { registration_number?: unknown; student_number?: unknown }): string {
  const value = String(student.registration_number || student.student_number || "").replace(/\s+/g, "").toUpperCase();
  if (!/^(?:N[A-Z]\d{4}\/\d{4}\/\d{4}|IDMC\/\d{4}\/\d{5})$/.test(value)) {
    throw new Error("A valid student registration number is required before first-login setup.");
  }
  return value;
}

export function needsStudentPasswordChange(metadata: Record<string, any> | undefined): boolean {
  return metadata?.idmc_student_first_login === true;
}

/** Initialize an unused student account once. Never reset an account that has logged in or changed its password. */
export async function initialiseStudentFirstLogin(authUserId: string, student: { registration_number?: unknown; student_number?: unknown }) {
  const db = getSupabase();
  const result = await db.auth.admin.getUserById(authUserId);
  if (result.error || !result.data.user) throw result.error || new Error("Student identity missing.");
  const identity = result.data.user;
  if (identity.app_metadata?.idmc_student_initialised === true) return;
  const profile = await db.from("users").select("id,password_changed_at,last_login_at").eq("auth_user_id", authUserId).maybeSingle();
  if (profile.error) throw profile.error;
  if (profile.data?.password_changed_at || profile.data?.last_login_at) return;
  if (profile.data) {
    const roles = await db.from("user_roles").select("roles!inner(role_code)").eq("user_id", profile.data.id).eq("status", "ACTIVE");
    if (roles.error) throw roles.error;
    if ((roles.data || []).some((r: any) => !["STUDENT", "APPLICANT"].includes(r.roles?.role_code))) return;
  }
  const number = studentInitialNumber(student);
  const updated = await db.auth.admin.updateUserById(authUserId, {
    password: number,
    app_metadata: { ...identity.app_metadata, idmc_student_initialised: true, idmc_student_first_login: true, idmc_student_initial_number: number },
  });
  if (updated.error) throw updated.error;
}

export async function createStudentFirstLoginIdentity(email: string, student: { registration_number?: unknown; student_number?: unknown }, data: Record<string, any>) {
  const number = studentInitialNumber(student);
  return getSupabase().auth.admin.createUser({ email, password: number, email_confirm: true,
    user_metadata: data,
    app_metadata: { idmc_student_initialised: true, idmc_student_first_login: true, idmc_student_initial_number: number },
  });
}
