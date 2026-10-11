import { getSupabase } from "../../../config/database.js";
import { env } from "../../../config/env.js";
import { sendAccountPasswordRecoveryEmail } from "../../../services/email.service.js";
import { initialiseStudentFirstLogin, needsStudentPasswordChange, studentInitialNumber } from "../../../services/student-first-login.service.js";
import { logError } from "../../../utils/logger.js";

const BLOCKED_STUDENT_STATUSES = new Set([
  "PENDING_ACTIVATION",
  "SUSPENDED",
  "WITHDRAWN",
  "EXPELLED",
  "DECEASED",
  "INACTIVE",
]);

interface StudentRow {
  id: string;
  student_number: string;
  registration_number?: string;
  user_id: string | null;
  student_status: string | null;
}

const INVALID = "Invalid login credentials";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

export function normaliseStudentNumber(value: string): string {
  // Student numbers have no meaningful whitespace; accept formatting such as
  // "NS1425 / 2020 / 2025" while keeping the stored identifier unchanged.
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

export function isValidStudentNumber(value: string): boolean {
  const number = normaliseStudentNumber(value);
  return /^N[A-Z]\d{4}\/\d{4}\/\d{4}$/.test(number) || /^IDMS\/\d{4}\/\d{5}$/.test(number);
}

async function findStudentByIdentifier(value: string): Promise<StudentRow | null> {
  if (!value || value.includes("*")) return null;
  const { data, error } = await getSupabase().from("students")
    .select("id,student_number,registration_number,user_id,student_status")
    .or(`student_number.ilike.${escapeLike(value)},registration_number.ilike.${escapeLike(value)}`)
    .limit(2);
  if (error) throw error;
  return data?.length === 1 ? data[0] as StudentRow : null;
}

/** Resolve an existing linked identity only; login must never create/link an account. */
export async function resolveStudentLoginEmail(identifier: string, password: string): Promise<string | null> {
  const studentNumber = normaliseStudentNumber(identifier);
  if (!isValidStudentNumber(studentNumber) || !password) return null;

  const student = await findStudentByIdentifier(studentNumber);
  if (!student || BLOCKED_STUDENT_STATUSES.has(String(student.student_status ?? "").toUpperCase()) || !student.user_id) return null;

  const supabase = getSupabase();
  const { data: user, error } = await supabase.from("users")
    .select("id,auth_user_id,status")
    .eq("id", student.user_id)
    .maybeSingle();
  if (error) throw error;
  if (!user || user.status !== "ACTIVE" || !user.auth_user_id) return null;

  const initialNumber = studentInitialNumber(student);
  const usingInitialPassword = normaliseStudentNumber(password) === initialNumber;
  if (usingInitialPassword) await initialiseStudentFirstLogin(String(user.auth_user_id), student);

  const { data, error: authError } = await supabase.auth.admin.getUserById(String(user.auth_user_id));
  const identity = data?.user;
  const email = String(identity?.email ?? "").trim().toLowerCase();
  if (authError || !email) throw new Error(INVALID);
  if (usingInitialPassword && (!needsStudentPasswordChange(identity?.app_metadata) || String(identity?.app_metadata?.idmc_student_initial_number ?? "").toUpperCase() !== initialNumber)) return null;
  return email;
}

function normalizeRecoveryIdentifier(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizePhone(value: unknown): string {
  let phone = String(value ?? "").replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = `255${phone.slice(1)}`;
  return phone;
}

/** Recover an account only after matching the account's existing institutional records. */
export async function requestVerifiedPasswordReset(
  input: { accountType: "student" | "lecturer"; email?: string; registrationNumber?: string; birthYear?: number; phone?: string },
  deliver: typeof sendAccountPasswordRecoveryEmail = sendAccountPasswordRecoveryEmail,
): Promise<boolean> {
  const suppliedEmail = String(input.email ?? "").trim().toLowerCase();
  if (input.accountType === "lecturer" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppliedEmail)) return false;
  const db = getSupabase();
  let email = suppliedEmail;
  let userId: string | null = null;
  let recoveryName = "IDMS account holder";

  if (input.accountType === "student") {
    const number = normalizeRecoveryIdentifier(input.registrationNumber);
    const enteredNumber = normaliseStudentNumber(String(input.registrationNumber ?? "").trim());
    const year = Number(input.birthYear);
    if (!number || !isValidStudentNumber(enteredNumber) || !Number.isInteger(year) || year < 1950 || year > new Date().getFullYear()) return false;
    const students = await db.from("students").select("id,student_number,registration_number,applicant_id,user_id,student_status,first_name,last_name,date_of_birth")
      .or(`student_number.ilike.${escapeLike(enteredNumber)},registration_number.ilike.${escapeLike(enteredNumber)}`).limit(2);
    if (students.error) throw students.error;
    const matches = (students.data ?? []).filter((row: any) => [row.registration_number, row.student_number].some(value => normalizeRecoveryIdentifier(value) === number));
    if (matches.length !== 1) return false;
    const student = matches[0]!;
    if (!student.user_id || BLOCKED_STUDENT_STATUSES.has(String(student.student_status ?? "").toUpperCase())) return false;
    const storedBirthYear = Number(String(student.date_of_birth ?? "").slice(0, 4));
    if (!storedBirthYear || storedBirthYear !== year) return false;
    userId = String(student.user_id);
    recoveryName = [student.first_name, student.last_name].filter(Boolean).join(" ") || recoveryName;
  } else if (input.accountType === "lecturer") {
    const phone = normalizePhone(input.phone);
    if (phone.length < 9 || phone.length > 15) return false;
    const staffRows = await db.from("staff").select("id,user_id,email,phone,staff_category,employment_status,first_name,last_name").ilike("email", email).limit(20);
    if (staffRows.error) throw staffRows.error;
    const matches = (staffRows.data ?? []).filter((row: any) => String(row.email ?? "").trim().toLowerCase() === email
      && normalizePhone(row.phone) === phone
      && String(row.staff_category ?? "").toUpperCase() === "ACADEMIC"
      && String(row.employment_status ?? "").toUpperCase() === "ACTIVE"
      && row.user_id);
    if (matches.length !== 1) return false;
    const lecturer = matches[0]!;
    userId = String(lecturer.user_id);
    recoveryName = [lecturer.first_name, lecturer.last_name].filter(Boolean).join(" ") || recoveryName;
  } else return false;

  const profile = await db.from("users").select("id,auth_user_id,status,display_name,first_name,last_name,email").eq("id", userId).maybeSingle();
  if (profile.error) throw profile.error;
  if (!profile.data || profile.data.status !== "ACTIVE" || !profile.data.auth_user_id) return false;
  if (input.accountType === "student") email = String(profile.data.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const { data: identity, error: identityError } = await db.auth.admin.getUserById(String(profile.data.auth_user_id));
  if (identityError || !identity?.user || String(identity.user.email ?? "").trim().toLowerCase() !== email || email.endsWith("@students.idmc.local")) return false;
  const { data: generated, error: linkError } = await db.auth.admin.generateLink({
    type: "recovery", email,
    options: { redirectTo: `${env.FRONTEND_URL.replace(/\/$/, "")}/set-password.html` },
  });
  if (linkError || !generated?.properties?.action_link) throw linkError ?? new Error("Unable to create password reset link.");
  try {
    await deliver({
      recipientEmail: email,
      recipientName: String(profile.data.display_name || [profile.data.first_name, profile.data.last_name].filter(Boolean).join(" ") || recoveryName),
      recoveryUrl: generated.properties.action_link,
    });
  } catch (smtpError) {
    const frontend = env.FRONTEND_URL.replace(/\/$/, "");
    const { error: fallbackError } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontend}/set-password.html`,
    });
    if (fallbackError) {
      const safeCode = (error: unknown) => {
        const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
        return /^[A-Z0-9_-]{1,40}$/.test(code) ? code : error instanceof Error ? error.name : "EMAIL_PROVIDER_FAILED";
      };
      logError("Password reset email delivery failed through Worker SMTP and Supabase Auth", {
        primaryCode: safeCode(smtpError),
        fallbackCode: safeCode(fallbackError),
      });
      throw new AggregateError([smtpError, fallbackError], "Password reset delivery failed through both email providers.");
    }
  }
  const { error: auditError } = await db.from("security_logs").insert({
    user_id: profile.data.id, event_code: "PASSWORD_RESET_REQUESTED", success: true,
    details: { account_type: input.accountType },
  });
  if (auditError) console.warn("Password reset email sent but security history was not recorded.");
  return true;
}
