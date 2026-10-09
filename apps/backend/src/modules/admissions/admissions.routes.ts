import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import { authenticate } from "../../middleware/auth.js";
import { requireAnyPermission, requirePermission } from "../../middleware/rbac.js";
import { getSupabase } from "../../config/database.js";
import { env } from "../../config/env.js";
import { privateStorageObjectPath } from "../../utils/private-storage-path.js";
import { registerCrudResource } from "../../utils/resourceCrud.js";
import { createAuditLog } from "../../services/audit.service.js";
import { createStudentFirstLoginIdentity, initialiseStudentFirstLogin } from "../../services/student-first-login.service.js";
import { sendAdmissionOfferEmail } from "../../services/email.service.js";
import { escapeIlikeLiteral, rolesGrantPermission, rolesGrantRole, scopeRoleAssignments } from "../../utils/security.js";

const router = Router();
router.use(authenticate);

router.get("/programme-requirements", requirePermission("admissions.view"), async (_req, res, next) => {
  try {
    const { data, error } = await getSupabase().from("programmes").select("id,programme_code,programme_name,award_level,specialization,direct_entry_requirements,duration_years,mode_of_study,status").order("programme_name");
    if (error) throw error;
    res.json({ success: true, data: data ?? [] });
  } catch (error) { next(error); }
});
router.patch("/programme-requirements/:id", requirePermission("admissions.manage"), async (req, res, next) => {
  try {
    const { data, error } = await getSupabase().from("programmes").update({
      specialization: typeof req.body?.specialization === "string" ? req.body.specialization.trim().slice(0, 2000) || null : null,
      direct_entry_requirements: typeof req.body?.directEntryRequirements === "string" ? req.body.directEntryRequirements.trim().slice(0, 5000) || null : null,
      updated_at: new Date().toISOString()
    }).eq("id", req.params.id).select("id,programme_code,programme_name,specialization,direct_entry_requirements").single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

async function admissionsWorkspaceAccess(req: any, res: any, next: any) {
  try {
    const roles = await getSupabase().from("user_roles")
      .select("role_id,assigned_at,status,expires_at,roles!inner(role_code,status)")
      .eq("user_id", req.user!.id).eq("status", "ACTIVE");
    if (roles.error) return next(roles.error);
    const scopedRoles = scopeRoleAssignments(roles.data, req.user!.activeRoleId);
    if (scopedRoles[0]?.role_id) req.user!.activeRoleId = scopedRoles[0].role_id;
    if (rolesGrantRole(scopedRoles, ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN", "ADMISSIONS_OFFICER"])) return next();
    return requireAnyPermission("applications.view", "admissions.view", "registration.view", "registration.manage")(req, res, next);
  } catch (error) {
    next(error);
  }
}

const wrap = (fn: any) => async (req: any, res: any, next: any) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

async function bulkAdmissionsAccess(req: any, res: any, next: any) {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Authentication required" });
    const action = String(req.body?.action || "").toUpperCase();
    const permission = ["SELECT", "ISSUE", "CONVERT", "RECONCILE"].includes(action) ? "admissions.manage" : "applications.manage";
    const roles = await getSupabase().from("user_roles")
      .select("role_id,assigned_at,status,expires_at,roles!inner(status,role_permissions!inner(permissions!inner(permission_code,status)))")
      .eq("user_id", req.user.id).eq("status", "ACTIVE");
    if (roles.error) return next(roles.error);
    const scopedRoles = scopeRoleAssignments(roles.data, req.user.activeRoleId);
    if (scopedRoles[0]?.role_id) req.user.activeRoleId = scopedRoles[0].role_id;
    if (!rolesGrantPermission(scopedRoles, permission)) return res.status(403).json({ success: false, message: `Permission denied: ${permission}` });
    next();
  } catch (error) { next(error); }
}

async function reconcileConvertedApplication(applicationId: string, actorUserId: string) {
  const db = getSupabase();
  const application = await db.from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (application.error) throw application.error;
  if (!application.data) throw Object.assign(new Error("Application not found."), { statusCode: 404 });
  if (application.data.status !== "CONVERTED_TO_STUDENT") throw Object.assign(new Error("Only a converted application can be reconciled."), { statusCode: 409 });

  const applicant = await db.from("applicants").select("*").eq("id", application.data.applicant_id).maybeSingle();
  if (applicant.error) throw applicant.error;
  if (!applicant.data) throw Object.assign(new Error("The converted application has no applicant record."), { statusCode: 409 });

  let student = await db.from("students").select("*").eq("source_application_id", applicationId).maybeSingle();
  if (student.error) throw student.error;
  if (!student.data) student = await db.from("students").select("*").eq("applicant_id", applicant.data.id).maybeSingle();
  if (student.error) throw student.error;
  if (!student.data) throw Object.assign(new Error("Application is marked converted but no student record exists. Restore or reconvert the admission before creating an account."), { statusCode: 409 });
  if (!applicant.data.auth_user_id) throw Object.assign(new Error("Applicant has no Supabase Auth identity to link."), { statusCode: 409 });

  const identity = await db.auth.admin.getUserById(applicant.data.auth_user_id);
  if (identity.error) throw identity.error;
  const verifiedEmail = identity.data.user?.email_confirmed_at ? String(identity.data.user.email || "").trim().toLowerCase() : "";
  if (!verifiedEmail) throw Object.assign(new Error("Applicant Auth account has no verified email. Verify the account before linking it to a student."), { statusCode: 409 });

  let publicUser = await db.from("users").select("*").eq("auth_user_id", applicant.data.auth_user_id).maybeSingle();
  if (publicUser.error) throw publicUser.error;
  if (publicUser.data && String(publicUser.data.email || "").trim().toLowerCase() !== verifiedEmail) {
    throw Object.assign(new Error("IDMC profile email does not match the verified Auth email. Reconcile the account before linking it to a student."), { statusCode: 409 });
  }
  if (!publicUser.data) {
    const emailOwner = await db.from("users").select("id,auth_user_id").ilike("email", escapeIlikeLiteral(verifiedEmail)).maybeSingle();
    if (emailOwner.error) throw emailOwner.error;
    if (emailOwner.data && emailOwner.data.auth_user_id !== applicant.data.auth_user_id) throw Object.assign(new Error("Applicant email already belongs to another IDMC user."), { statusCode: 409 });
    const created = await db.from("users").insert({
      auth_user_id: applicant.data.auth_user_id,
      user_number: student.data.student_number,
      username: String(student.data.registration_number || student.data.student_number).toLowerCase(),
      first_name: applicant.data.first_name || "Student",
      middle_name: applicant.data.middle_name || null,
      last_name: applicant.data.last_name || student.data.student_number,
      display_name: [applicant.data.first_name, applicant.data.middle_name, applicant.data.last_name].filter(Boolean).join(" "),
      email: verifiedEmail, phone: applicant.data.phone || null, status: "ACTIVE", email_verified_at: identity.data.user.email_confirmed_at
    }).select("*").single();
    if (created.error) throw created.error;
    publicUser = created;
  }

  if (student.data.user_id && student.data.user_id !== publicUser.data.id) {
    throw Object.assign(new Error("Student is already linked to a different IDMC account. Resolve the ownership conflict before reconciliation."), { statusCode: 409 });
  }

  if (student.data.user_id !== publicUser.data.id) {
    const linked = await db.from("students").update({ user_id: publicUser.data.id, updated_at: new Date().toISOString() }).eq("id", student.data.id).select("*").single();
    if (linked.error) throw linked.error;
    student.data = linked.data;
  }
  const role = await db.from("roles").select("id").eq("role_code", "STUDENT").eq("status", "ACTIVE").maybeSingle();
  if (role.error) throw role.error;
  if (!role.data) throw Object.assign(new Error("Active STUDENT role is missing."), { statusCode: 409 });
  const assignment = await db.from("user_roles").upsert({ user_id: publicUser.data.id, role_id: role.data.id, assigned_by: actorUserId, status: "ACTIVE" }, { onConflict: "user_id,role_id" });
  if (assignment.error) throw assignment.error;
  await initialiseStudentFirstLogin(String(publicUser.data.auth_user_id), student.data);
  return { applicationId, studentId: student.data.id, studentNumber: student.data.student_number, userId: publicUser.data.id, email: publicUser.data.email, linked: true };
}

async function issueAdmissionOffer(applicationId: string, actorUserId: string, requestId?: string | null, ipAddress?: string | null, selectApplication = false) {
  const db = getSupabase();
  const application = await db.from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (application.error) throw application.error;
  if (!application.data) throw Object.assign(new Error("Application not found."), { statusCode: 404 });
  const expiry = new Date(); expiry.setUTCDate(expiry.getUTCDate() + 30);
  const issued = await db.rpc("issue_admission_offer_atomic", {
    p_application_id: applicationId,
    p_actor_id: actorUserId,
    p_offer_number: `OFFER-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    p_expiry_date: expiry.toISOString().slice(0, 10),
    p_request_id: requestId ?? null,
    p_ip_address: ipAddress ?? null,
    p_select_application: selectApplication
  });
  if (issued.error) throw issued.error;
  const offerData = issued.data?.offer;
  if (!offerData) throw new Error("Offer issuance completed without returning the offer.");
  const newlyIssued = Boolean(issued.data.newly_issued);
  let emailSent: boolean | null = null, emailError: string | null = null;
  if (newlyIssued) {
    try {
      const [applicant, programme] = await Promise.all([
        db.from("applicants").select("first_name,middle_name,last_name,auth_user_id").eq("id", application.data.applicant_id).maybeSingle(),
        db.from("programmes").select("programme_code,programme_name").eq("id", issued.data.choice.programme_id).maybeSingle()
      ]);
      if (applicant.error) throw applicant.error;
      if (programme.error) throw programme.error;
      if (!applicant.data?.auth_user_id) throw new Error("Applicant has no linked Auth account; offer remains available in the applicant portal.");
      const identity = await db.auth.admin.getUserById(applicant.data.auth_user_id);
      if (identity.error) throw identity.error;
      const recipientEmail = identity.data.user?.email_confirmed_at ? identity.data.user.email : null;
      if (!recipientEmail) throw new Error("Applicant has no verified Auth email; offer remains available in the applicant portal.");
      await sendAdmissionOfferEmail({
        recipientEmail,
        recipientName: [applicant.data.first_name, applicant.data.middle_name, applicant.data.last_name].filter(Boolean).join(" ") || "Applicant",
        offerNumber: offerData.offer_number,
        programmeName: programme.data ? `${programme.data.programme_code} - ${programme.data.programme_name}` : "your selected programme",
        expiryDate: offerData.expiry_date || null
      });
      emailSent = true;
    } catch (error: any) {
      emailSent = false;
      emailError = String(error?.message || "Email delivery failed.").slice(0, 500);
      console.error(`[admissions] Offer ${offerData.offer_number} issued, but applicant email delivery failed: ${emailError}`);
    }
  }
  return { ...offerData, emailSent, emailError };
}

async function convertAcceptedApplication(applicationId: string, actorUserId: string) {
  const db = getSupabase();
  const current = await db.from("applications").select("status").eq("id", applicationId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) throw Object.assign(new Error("Application not found."), { statusCode: 404 });
  if (current.data.status === "CONVERTED_TO_STUDENT") return reconcileConvertedApplication(applicationId, actorUserId);
  if (current.data.status !== "ACCEPTED") throw Object.assign(new Error(`Only an accepted offer can create a student. Current status: ${current.data.status}.`), { statusCode: 409 });
  const converted = await db.rpc("convert_accepted_application_to_student", { p_application_id: applicationId });
  if (converted.error) throw converted.error;
  return reconcileConvertedApplication(applicationId, actorUserId);
}

router.get("/workspace", admissionsWorkspaceAccess, wrap(async (_req: any, res: any) => {
  const db = getSupabase();
  const [applications, applicants, choices, qualifications, documents, programmes, students, users, flag] = await Promise.all([
    db.from("applications").select("*").order("created_at", { ascending: false }).limit(500),
    db.from("applicants").select("id,applicant_number,first_name,middle_name,last_name,email,phone,date_of_birth,gender,nationality,address_line_1,district,region,status").limit(1000),
    db.from("application_choices").select("*").limit(2000),
    db.from("academic_qualifications").select("*").limit(2000),
    db.from("application_documents").select("*").limit(3000),
    db.from("programmes").select("id,programme_code,programme_name,status").limit(1000),
    db.from("students").select("id,student_number,registration_number,first_name,middle_name,last_name,programme_id,applicant_id,source_application_id,user_id,student_status").limit(2000),
    db.from("users").select("id,user_number,email,status").limit(3000),
    db.from("system_feature_flags").select("is_enabled,updated_at").eq("feature_code", "ONLINE_APPLICATIONS").limit(1).maybeSingle(),
  ]);
  for (const result of [applications, applicants, choices, qualifications, documents, programmes, students, users, flag]) {
    if (result.error) throw result.error;
  }
  const nextOfKin = await db.from("application_next_of_kin").select("application_id,full_name,relationship,phone,email,address").limit(1000);
  if (nextOfKin.error && !["PGRST205", "42P01"].includes(String(nextOfKin.error.code))) throw nextOfKin.error;
  const intakeRows=await db.from('idmc_intakes').select('id,code,academic_year_id,academic_years(year_name)');if(intakeRows.error)throw intakeRows.error;let intakeOpen=false;for(const i of intakeRows.data||[]){const x=await db.rpc('idmc_intake_state',{p_id:i.id});if(x.error)throw x.error;if(x.data==='OPEN')intakeOpen=true;}
  res.json({ success: true, data: {
    onlineApplicationsOpen: intakeOpen,intakes:intakeRows.data??[],
    applications: applications.data ?? [], applicants: applicants.data ?? [], choices: choices.data ?? [],
    qualifications: qualifications.data ?? [], documents: documents.data ?? [], programmes: programmes.data ?? [],
    students: students.data ?? [], users: users.data ?? [], nextOfKin: nextOfKin.data ?? []
  }});
}));

async function allRows(table: string, columns = "*") {
  const result: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await getSupabase().from(table).select(columns).order("id").range(offset, offset + 499);
    if (page.error) throw page.error;
    result.push(...(page.data ?? []));
    if ((page.data ?? []).length < 500) return result;
  }
}

function normalizeStudentPhotoNumber(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

router.post("/students/photo-matches", requirePermission("admissions.manage"), express.json({ limit: "64kb" }), wrap(async (req: any, res: any) => {
  const requested = Array.isArray(req.body?.studentNumbers) ? req.body.studentNumbers.slice(0, 100).map(normalizeStudentPhotoNumber) : [];
  if (!requested.length || requested.some((value: string) => !value)) throw Object.assign(new Error("Provide one or more valid Student Numbers."), { statusCode: 400 });
  const wanted = new Set(requested);
  const students = await allRows("students", "id,student_number,registration_number,first_name,middle_name,last_name");
  const matches = requested.map((lookupKey: string) => ({
    lookupKey,
    students: students.filter((row: any) => [row.student_number, row.registration_number].some(number => normalizeStudentPhotoNumber(number) === lookupKey))
      .map((row: any) => ({ id: row.id, studentNumber: row.student_number || row.registration_number, registrationNumber: row.registration_number, identifier: normalizeStudentPhotoNumber(row.student_number) === lookupKey ? row.student_number : row.registration_number, firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name }))
  }));
  res.json({ success: true, data: { matches, scanned: students.length, requested: wanted.size } });
}));

router.post("/students/:id/photo", requirePermission("admissions.manage"), express.json({ limit: "8mb" }), wrap(async (req: any, res: any) => {
  const photo = String(req.body?.profilePhoto || "");
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
  if (!match) throw Object.assign(new Error("Use a valid JPEG, PNG or WebP photo."), { statusCode: 400 });
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error("Photo exceeds the 5 MB per-file limit."), { statusCode: 413 });
  const actualMime = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? "image/jpeg"
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
  if (!actualMime) throw Object.assign(new Error("This file is not a valid JPEG, PNG or WebP image. Re-save or export the original photo as JPG, PNG or WebP and retry."), { statusCode: 400 });
  const db = getSupabase();
  const student = await db.from("students").select("id,student_number,registration_number,first_name,middle_name,last_name").eq("id", req.params.id).maybeSingle();
  if (student.error) throw student.error;
  if (!student.data) throw Object.assign(new Error("Student not found."), { statusCode: 404 });
  const identity = normalizeStudentPhotoNumber(req.body?.identifier);
  if (!identity || ![student.data.student_number, student.data.registration_number].some(number => identity === normalizeStudentPhotoNumber(number))) throw Object.assign(new Error("Photo Student Number does not match this student."), { statusCode: 409 });
  const canonicalPhoto = `data:${actualMime};base64,${bytes.toString("base64")}`;
  const saved = await db.from("students").update({ profile_photo_url: canonicalPhoto, updated_at: new Date().toISOString() }).eq("id", student.data.id);
  if (saved.error) throw saved.error;
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "UPDATE", entityType: "students", entityId: student.data.id, moduleCode: "ADMISSIONS", newValues: { photoUpdated: true } });
  res.json({ success: true, data: { studentId: student.data.id }, message: "Photo saved to the student profile." });
}));

router.get("/historical-students", admissionsWorkspaceAccess, wrap(async (_req: any, res: any) => {
  const db = getSupabase();
  const imported = await db.from("historical_import_rows").select("id,batch_id,student_id,normalized_data,row_number")
    .eq("validation_status", "IMPORTED").not("student_id", "is", null).order("row_number").limit(5000);
  if (imported.error) throw imported.error;
  const rows = imported.data ?? [];
  const rowIds = rows.map((row: any) => row.id);
  const existing = rowIds.length ? await db.from("historical_import_account_results").select("id,import_row_id,admission_status,account_status,student_id,batch_id").in("import_row_id", rowIds) : { data: [], error: null };
  if (existing.error) throw existing.error;
  const known = new Set((existing.data ?? []).map((row: any) => row.import_row_id));
  const missing = rows.filter((row: any) => !known.has(row.id)).map((row: any) => ({ batch_id: row.batch_id, import_row_id: row.id, student_id: row.student_id, admission_status: "PENDING", account_status: "PENDING" }));
  if (missing.length) {
    const created = await db.from("historical_import_account_results").insert(missing);
    if (created.error) throw created.error;
  }
  const queue = rowIds.length ? await db.from("historical_import_account_results").select("id,import_row_id,admission_status,account_status,student_id,batch_id,error_message,completed_at").in("import_row_id", rowIds).in("admission_status", ["PENDING", "CONFIRMED", "FAILED"]) : { data: [], error: null };
  if (queue.error) throw queue.error;
  const resultRows = queue.data ?? [];
  const studentIds = [...new Set(resultRows.map((row: any) => row.student_id).filter(Boolean))];
  const students = studentIds.length ? await db.from("students").select("id,student_number,registration_number,first_name,middle_name,last_name,email,phone,student_status,source_type,admission_year,programme_id").in("id", studentIds) : { data: [], error: null };
  if (students.error) throw students.error;
  const byId = new Map((students.data ?? []).map((student: any) => [student.id, student]));
  res.json({ success: true, data: resultRows.map((row: any) => ({ ...row, student: byId.get(row.student_id) ?? null })) });
}));

router.post("/historical-students/:id/confirm", requirePermission("admissions.manage"), wrap(async (req: any, res: any) => {
  const db = getSupabase(), now = new Date().toISOString();
  const pending = await db.from("historical_import_account_results").select("*").eq("id", req.params.id).maybeSingle();
  if (pending.error) throw pending.error;
  if (!pending.data) return res.status(404).json({ success: false, message: "Historical admission review was not found." });
  if (!['PENDING', 'FAILED'].includes(pending.data.admission_status)) return res.status(409).json({ success: false, message: "This historical student has already been reviewed." });
  const batch = await db.from("historical_import_batches").select("confirmed_by").eq("id", pending.data.batch_id).maybeSingle();
  if (batch.error) throw batch.error;
  if (batch.data?.confirmed_by === req.user!.id) return res.status(403).json({ success: false, message: "Four-eyes control: a different Admissions officer must confirm the imported student." });
  const studentResult = await db.from("students").select("id,institution_id,user_id,student_number,registration_number,first_name,middle_name,last_name,email,phone,student_status,source_type,source_reference").eq("id", pending.data.student_id).maybeSingle();
  if (studentResult.error) throw studentResult.error;
  const student = studentResult.data;
  if (!student || !["HISTORICAL_IMPORT", "MANUAL_ENTRY"].includes(student.source_type)) return res.status(409).json({ success: false, message: "This record is not a historical student." });
  try {
    const email = String(student.email || "").trim().toLowerCase();
    if (!email) throw Object.assign(new Error("Student email is required to create a portal account. Update the historical student record and retry."), { statusCode: 409 });
    let publicUser = student.user_id ? await db.from("users").select("id,auth_user_id,email").eq("id", student.user_id).maybeSingle() : { data: null, error: null };
    if (publicUser.error) throw publicUser.error;
    let authUserId = publicUser.data?.auth_user_id || pending.data.auth_user_id || null;
    if (!publicUser.data && authUserId) {
      const existing = await db.from("users").select("id,auth_user_id,email").eq("auth_user_id", authUserId).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data && String(existing.data.email).toLowerCase() !== email) throw new Error("Existing account email differs from the student record.");
      publicUser = existing;
    }
    if (!publicUser.data) {
      if (!authUserId) {
        const duplicate = await db.from("users").select("id,auth_user_id,email").ilike("email", escapeIlikeLiteral(email)).maybeSingle();
        if (duplicate.error) throw duplicate.error;
        if (duplicate.data) throw Object.assign(new Error("This email is already linked to another IDMC account. Resolve the account ownership before confirming the student."), { statusCode: 409 });
        const invited = await createStudentFirstLoginIdentity(email, student, { first_name: student.first_name, middle_name: student.middle_name, last_name: student.last_name, student_number: student.student_number });
        if (invited.error || !invited.data.user) throw invited.error || new Error("Could not invite student to the portal.");
        authUserId = invited.data.user.id;
        const saved = await db.from("historical_import_account_results").update({ auth_user_id: authUserId, account_status: "PENDING", updated_at: new Date().toISOString() }).eq("id", pending.data.id);
        if (saved.error) throw saved.error;
      }
      const existingProfile = await db.from("users").select("id,auth_user_id,email").eq("auth_user_id", authUserId).maybeSingle();
      if (existingProfile.error) throw existingProfile.error;
      if (existingProfile.data && String(existingProfile.data.email).toLowerCase() !== email) throw new Error("Student account ownership does not match.");
      const created = existingProfile.data ? existingProfile : await db.from("users").insert({ auth_user_id: authUserId, user_number: student.registration_number || student.student_number, username: String(student.registration_number || student.student_number).toLowerCase(), first_name: student.first_name || "Student", middle_name: student.middle_name || null, last_name: student.last_name || student.student_number, display_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "), email, phone: student.phone || null, status: "ACTIVE" }).select("id,auth_user_id,email").single();
      if (created.error) throw created.error;
      publicUser = created;
    }
    const linkedUser = publicUser.data;
    if (!linkedUser) throw new Error("Student account profile could not be loaded after creation.");
    const usedBy = await db.from("students").select("id").eq("user_id", linkedUser.id).neq("id", student.id).limit(1).maybeSingle();
    if (usedBy.error) throw usedBy.error;
    if (usedBy.data) throw new Error("Account is already linked to another student.");
    await initialiseStudentFirstLogin(String(linkedUser.auth_user_id), student);
    const role = await db.from("roles").select("id").eq("role_code", "STUDENT").eq("status", "ACTIVE").maybeSingle();
    if (role.error) throw role.error;
    if (!role.data) throw Object.assign(new Error("Active STUDENT role is missing."), { statusCode: 409 });
    const assigned = await db.from("user_roles").upsert({ user_id: linkedUser.id, role_id: role.data.id, assigned_by: req.user!.id, status: "ACTIVE" }, { onConflict: "user_id,role_id" });
    if (assigned.error) throw assigned.error;
    const activated = await db.from("students").update({ user_id: linkedUser.id, student_status: "ACTIVE", updated_at: now, updated_by: req.user!.id }).eq("id", student.id).select("id").maybeSingle();
    if (activated.error) throw activated.error;
    if (!activated.data) throw Object.assign(new Error("Student status changed during review; refresh and retry."), { statusCode: 409 });
    const updated = await db.from("historical_import_account_results").update({ admission_status: "CONFIRMED", account_status: "CREATED", user_id: linkedUser.id, auth_user_id: authUserId, error_message: null, completed_at: now, updated_at: now }).eq("id", pending.data.id).in("admission_status", ["PENDING", "FAILED"]).select("id").maybeSingle();
  if (updated.error) throw updated.error;
  if (!updated.data) return res.status(409).json({ success: false, message: "Another Admissions user completed this review; refresh the queue." });
    await createAuditLog({ actorUserId: req.user!.id, actionCode: "HISTORICAL_STUDENT_ADMISSION_CONFIRM", moduleCode: "admissions", entityType: "student", entityId: student.id, oldValues: { student_status: student.student_status, admission_status: pending.data.admission_status }, newValues: { student_status: "ACTIVE", admission_status: "CONFIRMED", user_id: linkedUser.id }, requestId: req.requestId, ipAddress: req.ip });
    res.json({ success: true, data: { studentId: student.id, studentNumber: student.student_number, admissionStatus: "CONFIRMED", accountStatus: "CREATED", userId: linkedUser.id }, message: `Historical student ${student.student_number} confirmed, linked to the Student role, and invited to set up portal access.` });
  } catch (error: any) {
    await db.from("historical_import_account_results").update({ admission_status: "FAILED", account_status: "FAILED", error_message: String(error?.message || "Account setup failed").slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", pending.data.id);
    throw error;
  }
}));

router.post("/review/bulk", bulkAdmissionsAccess, wrap(async (req: any, res: any) => {
  const action = String(req.body?.action || "").toUpperCase();
  const ids: string[] = Array.from(new Set<string>((Array.isArray(req.body?.applicationIds) ? req.body.applicationIds : []).map((id: any) => String(id)))).slice(0, 500);
  if (!ids.length) return res.status(400).json({ success: false, message: "Select at least one application." });
  if (!['CONFIRM','VERIFY_ALL','MARK_ELIGIBLE','SELECT','ISSUE','CONVERT','RECONCILE'].includes(action)) return res.status(400).json({ success: false, message: "Unsupported bulk action." });
  const db = getSupabase(), completed: any[] = [], failed: any[] = [], now = new Date().toISOString();
  for (const id of ids) {
    try {
      const app = await db.from("applications").select("*").eq("id", id).maybeSingle();
      if (app.error) throw app.error;
      if (!app.data) throw new Error("Application not found.");
      if (action === "RECONCILE") { completed.push(await reconcileConvertedApplication(id, req.user!.id)); continue; }
      if (action === "ISSUE") { completed.push({ applicationId: id, offer: await issueAdmissionOffer(id, req.user!.id, req.requestId, req.ip) }); continue; }
      if (action === "CONVERT") { completed.push({ applicationId: id, student: await convertAcceptedApplication(id, req.user!.id) }); continue; }
      if (action === "VERIFY_ALL") {
        const verified = await db.rpc("verify_application_records_atomic", {
          p_application_id: id,
          p_actor_id: req.user!.id,
          p_request_id: req.requestId ?? null,
          p_ip_address: req.ip ?? null
        });
        if (verified.error) throw verified.error;
        if (!verified.data) throw new Error("Application verification completed without returning a result.");
        completed.push({ applicationId: id, action, verification: verified.data });
        continue;
      }
      if (action === "CONFIRM") {
        if (app.data.status !== "SUBMITTED") throw new Error(`Status is ${app.data.status}; expected SUBMITTED.`);
        const changed = await db.from("applications").update({ status: "UNDER_REVIEW", verification_status: "IN_PROGRESS", reviewed_by: req.user!.id, reviewed_at: now, updated_at: now }).eq("id", id);
        if (changed.error) throw changed.error;
      } else {
        const qualifications = await db.from("academic_qualifications").select("id").eq("applicant_id", app.data.applicant_id);
        const documents = await db.from("application_documents").select("id").eq("application_id", id);
        if (qualifications.error) throw qualifications.error;
        if (documents.error) throw documents.error;
        if (!(qualifications.data ?? []).length) throw new Error("No qualification is attached.");
        if (!(documents.data ?? []).length) throw new Error("No certificate document is attached.");
        {
          const q = await db.from("academic_qualifications").select("verification_status").eq("applicant_id", app.data.applicant_id);
          const d = await db.from("application_documents").select("verification_status").eq("application_id", id);
          if ((q.data ?? []).some((row: any) => row.verification_status !== "VERIFIED") || (d.data ?? []).some((row: any) => row.verification_status !== "VERIFIED")) throw new Error("Verify all qualifications and documents first.");
          if (action === "SELECT") {
            const offer = await issueAdmissionOffer(id, req.user!.id, req.requestId, req.ip, true);
            completed.push({ applicationId: id, action, offer });
            continue;
          }
          const changed = await db.from("applications").update({ status: "ELIGIBLE", verification_status: "VERIFIED", eligibility_status: "ELIGIBLE", reviewed_by: req.user!.id, reviewed_at: now, updated_at: now }).eq("id", id);
          if (changed.error) throw changed.error;
        }
      }
      completed.push({ applicationId: id, action });
    } catch (error: any) { failed.push({ applicationId: id, message: error?.message || "Action failed." }); }
  }
  res.status(failed.length ? 207 : 200).json({ success: failed.length === 0, data: { completed, failed }, message: `${completed.length} completed; ${failed.length} failed.` });
}));

router.post("/reconcile-converted/:id", requirePermission("admissions.manage"), wrap(async (req: any, res: any) => {
  const result = await reconcileConvertedApplication(String(req.params.id), req.user!.id);
  res.json({ success: true, data: result, message: `Student ${result.studentNumber} is linked to an active IDMC user and STUDENT role.` });
}));

router.post("/review/:id/issue-offer", requirePermission("admissions.manage"), wrap(async (req: any, res: any) => {
  const offer = await issueAdmissionOffer(String(req.params.id), req.user!.id, req.requestId, req.ip);
  const delivery = offer.emailSent === false ? " Email delivery failed; the offer remains available in the applicant portal." : offer.emailSent ? " An email notification was sent to the applicant." : " The active offer is available in the applicant portal.";
  res.status(201).json({ success: true, data: offer, message: `Admission offer ${offer.offer_number} issued.${delivery} The applicant must accept it before student conversion.` });
}));

router.post("/review/:id/convert", requirePermission("admissions.manage"), wrap(async (req: any, res: any) => {
  const result = await convertAcceptedApplication(String(req.params.id), req.user!.id);
  res.json({ success: true, data: result, message: `Student ${result.studentNumber} created and linked successfully.` });
}));

router.post("/review/:id/archive", requirePermission("applications.archive"), wrap(async (req: any, res: any) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 2000);
  if (!reason) return res.status(400).json({ success: false, message: "Enter the archive reason." });
  const db = getSupabase();
  const current = await db.from("applications").select("id,status").eq("id", req.params.id).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return res.status(404).json({ success: false, message: "Application not found." });
  if (current.data.status === "CONVERTED_TO_STUDENT") return res.status(409).json({ success: false, message: "A converted application cannot be archived. Use the controlled student status workflow." });
  const result = await db.from("applications").update({ status: "CANCELLED", archived_at: new Date().toISOString(), archived_by: req.user!.id, archive_reason: reason, updated_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data, message: "Application archived. Its audit history was retained." });
}));

router.post("/online-publication", requirePermission("admissions.manage"), wrap(async (req: any, res: any) => {
  return res.status(409).json({success:false,message:'Choose March or September and configure its application window in Intake & Academic Progression.'});
}));

router.post("/review/:id/confirm", requirePermission("applications.manage"), wrap(async (req: any, res: any) => {
  const db = getSupabase();
  const current = await db.from("applications").select("id,status").eq("id", req.params.id).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return res.status(404).json({ success: false, message: "Application not found." });
  if (!["SUBMITTED", "CORRECTION_REQUIRED"].includes(current.data.status)) return res.status(409).json({ success: false, message: `Only a submitted application can be confirmed. Current status: ${current.data.status}.` });
  const now = new Date().toISOString();
  const result = await db.from("applications").update({ status: "UNDER_REVIEW", verification_status: "IN_PROGRESS", reviewed_by: req.user!.id, reviewed_at: now, review_comments: String(req.body?.comments || "Application received and confirmed by Admissions.").slice(0, 2000), updated_at: now }).eq("id", req.params.id).select().single();
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data, message: "Application confirmed and moved to review." });
}));

router.post("/review/:id/decision", requirePermission("applications.manage"), wrap(async (req: any, res: any) => {
  const decision = String(req.body?.decision || "").toUpperCase();
  if (!["REQUEST_CORRECTION", "MARK_ELIGIBLE", "SELECT", "REJECT"].includes(decision)) return res.status(400).json({ success: false, message: "Unsupported admission decision." });
  const db = getSupabase();
  const current = await db.from("applications").select("*").eq("id", req.params.id).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return res.status(404).json({ success: false, message: "Application not found." });
  if (!["UNDER_REVIEW", "VERIFIED", "ELIGIBLE", "CORRECTION_REQUIRED"].includes(current.data.status)) return res.status(409).json({ success: false, message: `Application decision is not allowed while status is ${current.data.status}.` });
  const comments = String(req.body?.comments || "").trim().slice(0, 2000);
  if (["REQUEST_CORRECTION", "REJECT"].includes(decision) && !comments) return res.status(400).json({ success: false, message: "Enter the reason for this decision." });
  const now = new Date().toISOString();
  const update: Record<string, any> = { reviewed_by: req.user!.id, reviewed_at: now, review_comments: comments || current.data.review_comments, updated_at: now };
  if (decision === "REQUEST_CORRECTION") Object.assign(update, { status: "CORRECTION_REQUIRED", verification_status: "CORRECTION_REQUIRED" });
  if (decision === "MARK_ELIGIBLE" || decision === "SELECT") {
    const [qualifications, documents] = await Promise.all([
      db.from("academic_qualifications").select("id,verification_status").eq("applicant_id", current.data.applicant_id),
      db.from("application_documents").select("id,verification_status").eq("application_id", current.data.id)
    ]);
    if (qualifications.error) throw qualifications.error;
    if (documents.error) throw documents.error;
    if (!(qualifications.data ?? []).length || (qualifications.data ?? []).some(row => row.verification_status !== "VERIFIED")) return res.status(409).json({ success: false, message: "Verify every academic qualification before marking the application eligible." });
    if (!(documents.data ?? []).length || (documents.data ?? []).some(row => row.verification_status !== "VERIFIED")) return res.status(409).json({ success: false, message: "Verify every required document before marking the application eligible." });
    Object.assign(update, { status: decision === "SELECT" ? "SELECTED" : "ELIGIBLE", verification_status: "VERIFIED", eligibility_status: "ELIGIBLE" });
    if (decision === "SELECT") update.selection_status = "SELECTED";
  }
  if (decision === "REJECT") Object.assign(update, { status: "REJECTED", eligibility_status: "INELIGIBLE", selection_status: "NOT_SELECTED" });
  const result = await db.from("applications").update(update).eq("id", current.data.id).select().single();
  if (result.error) throw result.error;
  if (decision === "SELECT") {
    const offer = await issueAdmissionOffer(current.data.id, req.user!.id, req.requestId, req.ip);
    const delivery = offer.emailSent === false ? " Email delivery failed; the offer remains available in the applicant portal." : offer.emailSent ? " An email notification was sent to the applicant." : " The active offer is available in the applicant portal.";
    return res.json({ success: true, data: { application: result.data, offer }, message: `Applicant selected and admission offer ${offer.offer_number} issued.${delivery}` });
  }
  res.json({ success: true, data: result.data, message: "Admission decision saved." });
}));

router.post("/review/qualifications/:id", requirePermission("applications.manage"), wrap(async (req: any, res: any) => {
  const decision = String(req.body?.decision || "").toUpperCase();
  if (!["VERIFIED", "REJECTED", "REQUIRES_REVIEW"].includes(decision)) return res.status(400).json({ success: false, message: "Decision must be VERIFIED, REJECTED or REQUIRES_REVIEW." });
  const result = await getSupabase().from("academic_qualifications").update({ verification_status: decision, verified_by: req.user!.id, verified_at: new Date().toISOString(), verification_comments: String(req.body?.comments || "").slice(0, 4000), updated_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data });
}));

router.post("/review/documents/:id", requirePermission("applications.manage"), wrap(async (req: any, res: any) => {
  const decision = String(req.body?.decision || "").toUpperCase();
  if (!["VERIFIED", "REJECTED", "CORRECTION_REQUIRED"].includes(decision)) return res.status(400).json({ success: false, message: "Decision must be VERIFIED, REJECTED or CORRECTION_REQUIRED." });
  const now = new Date().toISOString();
  const result = await getSupabase().from("application_documents").update({ verification_status: decision, verified_by: req.user!.id, verified_at: now, rejection_reason: decision === "VERIFIED" ? null : String(req.body?.comments || "Reason required").slice(0, 2000), updated_at: now }).eq("id", req.params.id).select().single();
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data });
}));

router.get("/review/documents/:id/access", requirePermission("applications.view"), wrap(async (req: any, res: any) => {
  const db = getSupabase();
  const document = await db.from("application_documents").select("id,application_id,document_name,file_url").eq("id", req.params.id).maybeSingle();
  if (document.error) throw document.error;
  if (!document.data) return res.status(404).json({ success: false, message: "Document not found." });
  const application = await db.from("applications").select("applicant_id").eq("id", document.data.application_id).maybeSingle();
  if (application.error) throw application.error;
  const prefixes = [`admissions/${document.data.application_id}/`, ...(application.data?.applicant_id ? [`applicants/${application.data.applicant_id}/${document.data.application_id}/`] : [])];
  const path = privateStorageObjectPath(document.data.file_url, env.SUPABASE_URL, prefixes);
  if (!path) return res.status(404).json({ success: false, message: "Document storage path is invalid or unavailable." });
  const signed = await db.storage.from("idmc-private-documents").createSignedUrl(path, 600);
  if (signed.error) throw signed.error;
  res.json({ success: true, data: { documentName: document.data.document_name, url: signed.data.signedUrl, expiresIn: 600 } });
}));

registerCrudResource(router, {
  moduleCode: "APPLICATIONS", entityType: "applicants", table: "applicants",
  permissionView: "applications.view", permissionManage: "applications.manage",
  searchFields: ["applicant_number","first_name","middle_name","last_name","email","phone","national_id_number","passport_number"],
  filterFields: ["applicant_type","status","nationality","gender"], defaultOrderField: "created_at",
  fields: { applicantNumber:"applicant_number", firstName:"first_name", middleName:"middle_name", lastName:"last_name",
    gender:"gender", dateOfBirth:"date_of_birth", nationality:"nationality", nationalIdNumber:"national_id_number",
    passportNumber:"passport_number", email:"email", phone:"phone", addressLine1:"address_line_1", addressLine2:"address_line_2",
    city:"city", district:"district", region:"region", country:"country", disabilityStatus:"disability_status",
    disabilityDetails:"disability_details", applicantType:"applicant_type", status:"status" }
}, "/applicants");

registerCrudResource(router, {
  moduleCode: "APPLICATIONS", entityType: "applications", table: "applications",
  permissionView: "applications.view", permissionManage: "applications.manage",
  searchFields: ["application_number","status","payment_status","verification_status","eligibility_status","selection_status"],
  filterFields: ["applicant_id","academic_year_id","application_type","entry_category","application_round","status","payment_status","verification_status","eligibility_status","selection_status"],
  defaultOrderField: "created_at",
  fields: { applicantId:"applicant_id", academicYearId:"academic_year_id", applicationNumber:"application_number",
    intakeId:"intake_id", applicationType:"application_type", entryCategory:"entry_category", applicationRound:"application_round", submittedAt:"submitted_at", status:"status",
    paymentStatus:"payment_status", verificationStatus:"verification_status", eligibilityStatus:"eligibility_status",
    selectionStatus:"selection_status", completionPercentage:"completion_percentage", correctionCount:"correction_count",
    correctionDeadline:"correction_deadline", reviewedBy:"reviewed_by", reviewedAt:"reviewed_at", reviewComments:"review_comments" }
}, "/applications");

registerCrudResource(router, {
  moduleCode: "APPLICATIONS", entityType: "application_choices", table: "application_choices",
  permissionView: "applications.view", permissionManage: "applications.manage",
  searchFields: ["choice_number","preference_type","status","decision_reason"], filterFields: ["application_id","programme_id","choice_number","status"],
  defaultOrderField: "created_at", fields: { applicationId:"application_id", programmeId:"programme_id", choiceNumber:"choice_number",
    preferenceType:"preference_type", status:"status", decisionReason:"decision_reason" }
}, "/choices");

registerCrudResource(router, {
  moduleCode: "APPLICATIONS", entityType: "academic_qualifications", table: "academic_qualifications",
  permissionView: "applications.view", permissionManage: "applications.manage",
  searchFields: ["qualification_type","institution_name","award_name","index_number","field_of_study"],
  filterFields: ["applicant_id","qualification_type","verification_status","completion_year"], defaultOrderField: "created_at",
  fields: { applicantId:"applicant_id", qualificationType:"qualification_type", institutionName:"institution_name", country:"country",
    awardName:"award_name", indexNumber:"index_number", registrationNumber:"registration_number", startYear:"start_year",
    completionYear:"completion_year", grade:"grade", gpa:"gpa", fieldOfStudy:"field_of_study", verificationStatus:"verification_status",
    verifiedBy:"verified_by", verifiedAt:"verified_at", verificationComments:"verification_comments" }
}, "/qualifications");

registerCrudResource(router, {
  moduleCode: "APPLICATIONS", entityType: "application_documents", table: "application_documents",
  permissionView: "applications.view", permissionManage: "applications.manage",
  searchFields: ["document_type","document_name","document_number","mime_type","verification_status"],
  filterFields: ["application_id","document_type","verification_status"], defaultOrderField: "uploaded_at",
  fields: { applicationId:"application_id", documentType:"document_type", documentName:"document_name", fileUrl:"file_url",
    fileSize:"file_size", mimeType:"mime_type", documentNumber:"document_number", issueDate:"issue_date", expiryDate:"expiry_date",
    verificationStatus:"verification_status", verifiedBy:"verified_by", verifiedAt:"verified_at", rejectionReason:"rejection_reason", uploadedAt:"uploaded_at" }
}, "/documents");

registerCrudResource(router, {
  moduleCode: "ADMISSIONS", entityType: "admission_decisions", table: "admission_decisions",
  permissionView: "admissions.view", permissionManage: "admissions.manage",
  searchFields: ["decision_type","decision_status","decision_reason"], filterFields: ["application_id","application_choice_id","decision_type","decision_status"],
  defaultOrderField: "decision_date", fields: { applicationId:"application_id", applicationChoiceId:"application_choice_id", decisionType:"decision_type",
    decisionStatus:"decision_status", decisionDate:"decision_date", decisionReason:"decision_reason", capacityCheck:"capacity_check",
    academicCheck:"academic_check", documentCheck:"document_check", approvedBy:"approved_by", approvedAt:"approved_at" }
}, "/admission-decisions");

registerCrudResource(router, {
  moduleCode: "ADMISSIONS", entityType: "admission_offers", table: "admission_offers",
  permissionView: "admissions.view", permissionManage: "admissions.manage",
  searchFields: ["offer_number","offer_status","admission_conditions"], filterFields: ["application_id","programme_id","decision_id","offer_status"],
  defaultOrderField: "offer_date", fields: { applicationId:"application_id", programmeId:"programme_id", decisionId:"decision_id", offerNumber:"offer_number",
    offerDate:"offer_date", expiryDate:"expiry_date", offerStatus:"offer_status", admissionConditions:"admission_conditions",
    admissionLetterUrl:"admission_letter_url", joiningInstructionsUrl:"joining_instructions_url", issuedBy:"issued_by", issuedAt:"issued_at" }
}, "/admission-offers");

registerCrudResource(router, {
  moduleCode: "ADMISSIONS", entityType: "admission_acceptances", table: "admission_acceptances",
  permissionView: "admissions.view", permissionManage: "admissions.manage",
  searchFields: ["acceptance_status","decline_reason"], filterFields: ["admission_offer_id","acceptance_status"], defaultOrderField: "created_at",
  fields: { admissionOfferId:"admission_offer_id", acceptanceStatus:"acceptance_status", acceptedAt:"accepted_at", declinedAt:"declined_at",
    declineReason:"decline_reason", acceptanceIpAddress:"acceptance_ip_address", acceptanceUserAgent:"acceptance_user_agent", acceptedBy:"accepted_by" }
}, "/admission-acceptances");

export default router;
