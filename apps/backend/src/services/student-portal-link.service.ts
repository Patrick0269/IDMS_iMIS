import { getSupabase } from "../config/database.js";
import { createStudentFirstLoginIdentity, initialiseStudentFirstLogin } from "./student-first-login.service.js";
import { sendStudentPortalAccessEmail } from "./email.service.js";
import { escapeIlikeLiteral } from "../utils/security.js";
import { logError } from "../utils/logger.js";

type Row = Record<string, any>;

/** Ensures a student has an IDMC user profile and the active STUDENT role. */
export async function linkStudentPortalAccount(studentId: string, actorUserId: string | null = null) {
  const db = getSupabase();
  const studentResult = await db.from("students")
    .select("id,user_id,applicant_id,source_application_id,student_number,registration_number,first_name,middle_name,last_name,email,phone")
    .eq("id", studentId).maybeSingle();
  if (studentResult.error) throw studentResult.error;
  const student = studentResult.data as Row | null;
  if (!student) throw new Error("Student record was not found while linking portal access.");

  let linkedAccount: Row | null = null;
  if (student.user_id) {
    const linked = await db.from("users").select("id,auth_user_id,email,status").eq("id", student.user_id).maybeSingle();
    if (linked.error) throw linked.error;
    linkedAccount = linked.data;
  }

  let applicant: Row | null = null;
  if (student.applicant_id) {
    const result = await db.from("applicants").select("first_name,middle_name,last_name,email,phone,auth_user_id").eq("id", student.applicant_id).maybeSingle();
    if (result.error) throw result.error;
    applicant = result.data;
  } else if (student.source_application_id) {
    const application = await db.from("applications").select("applicant_id").eq("id", student.source_application_id).maybeSingle();
    if (application.error) throw application.error;
    if (application.data?.applicant_id) {
      const result = await db.from("applicants").select("first_name,middle_name,last_name,email,phone,auth_user_id").eq("id", application.data.applicant_id).maybeSingle();
      if (result.error) throw result.error;
      applicant = result.data;
    }
  }

  const email = String(applicant?.email || student.email || linkedAccount?.email || "").trim().toLowerCase();
  if (!email) throw new Error("Student email is required before portal access can be linked.");

  // Prefer the applicant's original Auth identity when one was recorded at
  // application time. Older imports can leave students.user_id pointing at a
  // different/partial profile; choosing that stale row first prevents a valid
  // applicant account from being repaired.
  let account: Row | null = null;
  if (applicant?.auth_user_id) {
    const byApplicantIdentity = await db.from("users").select("id,auth_user_id,email,status").eq("auth_user_id", applicant.auth_user_id).maybeSingle();
    if (byApplicantIdentity.error) throw byApplicantIdentity.error;
    account = byApplicantIdentity.data;
  }
  if (!account) {
    const byEmail = await db.from("users").select("id,auth_user_id,email,status").ilike("email", escapeIlikeLiteral(email)).maybeSingle();
    if (byEmail.error) throw byEmail.error;
    account = byEmail.data;
  }
  if (!account && applicant?.auth_user_id) {
    const createdProfile = await db.from("users").insert({
        auth_user_id: applicant.auth_user_id,
        user_number: student.registration_number || student.student_number,
        username: String(student.registration_number || student.student_number).trim().toLowerCase(),
        first_name: student.first_name || applicant.first_name || "Student",
        middle_name: student.middle_name || applicant.middle_name || null,
        last_name: student.last_name || applicant.last_name || student.student_number,
        display_name: [student.first_name || applicant.first_name, student.middle_name || applicant.middle_name, student.last_name || applicant.last_name].filter(Boolean).join(" "),
        email,
        phone: student.phone || applicant.phone || null,
        status: "ACTIVE",
      }).select("id,auth_user_id,email,status").single();
    if (createdProfile.error) throw createdProfile.error;
    account = createdProfile.data;
  }
  if (!account && linkedAccount && String(linkedAccount.email || "").trim().toLowerCase() === email) {
    account = linkedAccount;
  }
  if (account && applicant?.auth_user_id && String(account.auth_user_id) !== String(applicant.auth_user_id)) {
    throw new Error("The applicant and IDMC user email point to different login identities. An administrator must reconcile the duplicate account before student access can be repaired.");
  }
  if (account && !account.auth_user_id) {
    throw new Error("A user profile already uses this email but has no login identity. Resolve that account before linking the student.");
  }
  if (account && String(account.status || "").toUpperCase() !== "ACTIVE") {
    throw new Error("The matching IDMC user account is inactive. An administrator must reactivate it before portal access can be linked.");
  }

  if (account && student.user_id && String(student.user_id) !== String(account.id)) {
    throw new Error("Student is already linked to a different IDMC account. An administrator must reconcile the account ownership before portal access can be repaired.");
  }

  const firstName = String(student.first_name || applicant?.first_name || "Student").trim();
  const middleName = String(student.middle_name || applicant?.middle_name || "").trim() || null;
  const lastName = String(student.last_name || applicant?.last_name || student.student_number).trim();
  const displayName = [firstName, middleName, lastName].filter(Boolean).join(" ");
  const username = String(student.registration_number || student.student_number).trim().toLowerCase();
  const userNumber = String(student.registration_number || student.student_number).trim();
  if (account) {
    const emailOwner = await db.from("users").select("id").ilike("email", escapeIlikeLiteral(email)).neq("id", account.id).maybeSingle();
    if (emailOwner.error) throw emailOwner.error;
    if (emailOwner.data) throw new Error("The applicant email is linked to another IDMC account. Resolve account ownership before linking this student.");
  }

  let invited = false;
  if (!account) {
    const invite = await createStudentFirstLoginIdentity(email, student, {
      first_name: firstName, middle_name: middleName, last_name: lastName,
      student_number: student.student_number, registration_number: userNumber,
    });
    if (invite.error || !invite.data.user) throw invite.error || new Error("Could not create the student's portal login.");
    // New accounts use a temporary number password and a server-enforced change gate.
    const existingProfile = await db.from("users").select("id,auth_user_id,email,status").eq("auth_user_id", invite.data.user.id).maybeSingle();
    if (existingProfile.error) throw existingProfile.error;
    if (existingProfile.data && String(existingProfile.data.email).toLowerCase() !== email) throw new Error("Created identity profile does not match student email.");
    const created = existingProfile.data ? existingProfile : await db.from("users").insert({
      auth_user_id: invite.data.user.id,
      user_number: userNumber,
      username,
      first_name: firstName,
      middle_name: middleName,
      last_name: lastName,
      display_name: displayName,
      email,
      phone: student.phone || null,
      status: "ACTIVE",
    }).select("id,auth_user_id,email,status").single();
    if (created.error) {
      // Preserve the identity for a safe retry; never delete a potentially trigger-linked account.
      throw created.error;
    }
    account = created.data;
    invited = true;
  }

  if (!account || !account.auth_user_id) {
    throw new Error("Student account profile was not available after creation or lookup.");
  }

  const role = await db.from("roles").select("id").eq("role_code", "STUDENT").eq("status", "ACTIVE").maybeSingle();
  if (role.error) throw role.error;
  if (!role.data) throw new Error("The active STUDENT role is not configured.");
  const anotherStudent = await db.from("students").select("id,student_number").eq("user_id", account.id).neq("id", student.id).limit(1).maybeSingle();
  if (anotherStudent.error) throw anotherStudent.error;
  if (anotherStudent.data) throw new Error(`This login is already linked to another student (${anotherStudent.data.student_number || anotherStudent.data.id}).`);
  await initialiseStudentFirstLogin(String(account.auth_user_id), student);
  const authIdentity = await db.auth.admin.getUserById(String(account.auth_user_id));
  if (authIdentity.error || !authIdentity.data.user) throw authIdentity.error || new Error("Student login identity could not be found.");
  const currentAuthEmail = String(authIdentity.data.user.email || "").trim().toLowerCase();
  if (currentAuthEmail !== email) {
    const updatedAuth = await db.auth.admin.updateUserById(String(account.auth_user_id), {
      email,
      email_confirm: true,
      user_metadata: { ...authIdentity.data.user.user_metadata, first_name: firstName, middle_name: middleName, last_name: lastName, display_name: displayName, student_number: student.student_number, registration_number: userNumber },
    });
    if (updatedAuth.error) throw updatedAuth.error;
  }
  const updatedUser = await db.from("users").update({ user_number: userNumber, username, first_name: firstName, middle_name: middleName, last_name: lastName, display_name: displayName, email, phone: student.phone || applicant?.phone || null, status: "ACTIVE", updated_at: new Date().toISOString() }).eq("id", account.id);
  if (updatedUser.error) throw updatedUser.error;
  const linkedStudent = await db.from("students").update({ user_id: account.id, email, first_name: firstName, middle_name: middleName, last_name: lastName, phone: student.phone || applicant?.phone || null, updated_at: new Date().toISOString() })
    .eq("id", student.id).select("id").single();
  if (linkedStudent.error) throw linkedStudent.error;
  const assigned = await db.from("user_roles").upsert({
    user_id: account.id,
    role_id: role.data.id,
    assigned_by: actorUserId,
    status: "ACTIVE",
  }, { onConflict: "user_id,role_id" });
  if (assigned.error) throw assigned.error;
  let welcomeEmailSent = false;
  if (invited) {
    try {
      await sendStudentPortalAccessEmail({ recipientEmail: email, recipientName: displayName, studentNumber: userNumber });
      welcomeEmailSent = true;
    } catch (error) {
      const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
      logError("Student portal account was created but its access email was not accepted", {
        code: typeof candidate.code === "string" ? candidate.code : "EMAIL_SEND_FAILED",
      });
    }
  }
  return { userId: account.id, username, studentNumber: student.student_number, registrationNumber: userNumber, email, invited, welcomeEmailSent };
}
