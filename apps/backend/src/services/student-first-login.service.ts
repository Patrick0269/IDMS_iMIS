import { getSupabase } from "../config/database.js";
import { env } from "../config/env.js";
import { getLocalAuthUserById, updateLocalAuthCredentials, createLocalAuthUser } from "./postgres-auth.service.js";
import { randomUUID } from "node:crypto";

export function studentInitialNumber(student: { registration_number?: unknown; student_number?: unknown }): string {
  const value = String(student.registration_number || student.student_number || "").replace(/\s+/g, "").toUpperCase();
  if (!/^(?:N[A-Z]\d{4}\/\d{4}\/\d{4}|IDMS\/\d{4}\/\d{5})$/.test(value)) {
    throw new Error("A valid student registration number is required before first-login setup.");
  }
  return value;
}

export function needsStudentPasswordChange(metadata: Record<string, any> | undefined): boolean {
  return metadata?.idmc_student_first_login === true;
}

/** Initialize an unchanged student account once. A prior login alone does not prove the student changed their password. */
export async function initialiseStudentFirstLogin(authUserId: string, student: { registration_number?: unknown; student_number?: unknown }) {
  const db = getSupabase();
  const identity = env.AUTH_PROVIDER === "postgres"
    ? await getLocalAuthUserById(authUserId)
    : (await db.auth.admin.getUserById(authUserId)).data?.user;
  if (!identity) throw new Error("Student identity missing.");
  const appMetadata = ("raw_app_meta_data" in identity ? identity.raw_app_meta_data : identity.app_metadata) ?? {};
  const number = studentInitialNumber(student);
  const recordedInitialNumber = String(appMetadata.idmc_student_initial_number ?? "").replace(/\s+/g, "").toUpperCase();
  if (appMetadata.idmc_student_initialised === true && recordedInitialNumber === number) return;
  const profile = await db.from("users").select("id,password_changed_at").eq("auth_user_id", authUserId).maybeSingle();
  if (profile.error) throw profile.error;
  // Existing/historical student accounts may already have last_login_at from
  // before the forced first-password-change flow was introduced. Only the
  // explicit password-change timestamp means the temporary password is no
  // longer allowed.
  if (profile.data?.password_changed_at) return;
  if (profile.data) {
    const roles = await db.from("user_roles").select("roles!inner(role_code)").eq("user_id", profile.data.id).eq("status", "ACTIVE");
    if (roles.error) throw roles.error;
    if ((roles.data || []).some((r: any) => !["STUDENT", "APPLICANT"].includes(r.roles?.role_code))) return;
  }
  const metadata = { ...appMetadata, idmc_student_initialised: true, idmc_student_first_login: true, idmc_student_initial_number: number };
  if (env.AUTH_PROVIDER === "postgres") {
    await updateLocalAuthCredentials({ id: authUserId, password: number, appMetadata: metadata });
  } else {
    const updated = await db.auth.admin.updateUserById(authUserId, { password: number, app_metadata: metadata });
    if (updated.error) throw updated.error;
  }
}

export async function createStudentFirstLoginIdentity(email: string, student: { registration_number?: unknown; student_number?: unknown }, data: Record<string, any>) {
  const number = studentInitialNumber(student);
  if (env.AUTH_PROVIDER === "postgres") {
    try {
      const user = await createLocalAuthUser({ id: randomUUID(), email, password: number, emailConfirmed: true, userMetadata: data, appMetadata: { idmc_student_initialised: true, idmc_student_first_login: true, idmc_student_initial_number: number } });
      return { data: { user: { id: user.id, email: user.email, app_metadata: user.raw_app_meta_data, user_metadata: user.raw_user_meta_data } }, error: null };
    } catch (error) {
      return { data: { user: null }, error };
    }
  }
  return getSupabase().auth.admin.createUser({ email, password: number, email_confirm: true,
    user_metadata: data,
    app_metadata: { idmc_student_initialised: true, idmc_student_first_login: true, idmc_student_initial_number: number },
  });
}
