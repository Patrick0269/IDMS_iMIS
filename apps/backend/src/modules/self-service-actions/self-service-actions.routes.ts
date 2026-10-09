import { randomUUID } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";

import { periodMappings, offeringAllowed } from "../academic-core/academic-eligibility.js";
import { httpError } from "../../utils/httpError.js";
import { privateDocumentMatchesMime } from "../../utils/private-document-validation.js";

type Row = Record<string, any>;
const router = Router();
router.use(authenticate);

function text(value: unknown, max = 2000): string | null {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, max) : null;
}
function userId(req: Request): string {
  if (!req.user?.id) throw httpError("Authentication required.", 401);
  return req.user.id;
}
async function student(req: Request): Promise<Row> {
  const result = await getSupabase().from("students").select("*").eq("user_id", userId(req)).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw httpError("The authenticated account is not linked to a student record.", 404);
  return result.data;
}
async function staff(req: Request): Promise<Row> {
  const result = await getSupabase().from("staff").select("*").eq("user_id", userId(req)).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw httpError("The authenticated account is not linked to a staff record.", 404);
  return result.data;
}
function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { res.json({ success: true, data: await action(req) }); }
    catch (error) { next(error); }
  };
}

router.get("/student/registration", requirePermission("students.self.view"), handle(async req => {
  const db = getSupabase(); const own = await student(req);
  const registrations = await db.from("student_registrations").select("*").eq("student_id", own.id).order("created_at", { ascending: false }).limit(20);
  if (registrations.error) throw registrations.error;
  const current = (registrations.data??[]).find((r:Row)=>r.academic_year_id===own.current_academic_year_id&&r.programme_id===own.programme_id&&r.programme_version_id===own.programme_version_id) ?? null;
  const programmeVersionId = current?.programme_version_id || own.programme_version_id;
  const currentSemester = current ? await db.from("semesters").select("semester_number").eq("id", current.semester_id).single() : { data: null, error: null };
  if (currentSemester.error) throw currentSemester.error;
  // Cross-cutting courses are offered only to programmes whose active
  // curriculum explicitly includes the course. The global course flag alone
  // must not expose it to every student in the institution.
  const curriculumIds: string[] = own.curriculum_id ? [own.curriculum_id] : [];
  let curriculumRows: Row[] = [];
  if (curriculumIds.length) {
    const mappings = await db.from("curriculum_courses").select("course_id,credit_units,course_category,year_number,semester_number,is_compulsory").in("curriculum_id", curriculumIds);
    if (mappings.error) throw mappings.error;
    curriculumRows = currentSemester.data ? periodMappings((mappings.data ?? []).filter((m:Row)=>m.year_number===own.current_year_number), Number(currentSemester.data.semester_number)) : [];
  }
  const curriculumCourseIds = [...new Set(curriculumRows.map((row: Row) => row.course_id))];
  const sharedCoursesResult = curriculumCourseIds.length
    ? await db.from("courses").select("id,level,cross_cutting").in("id", curriculumCourseIds).eq("status", "ACTIVE")
    : { data: [], error: null };
  if (sharedCoursesResult.error) throw sharedCoursesResult.error;
  const sharedCourseIds = (sharedCoursesResult.data ?? []).filter((row:Row)=>row.cross_cutting).map((row: Row) => row.id);
  const passed=await db.from('course_results').select('course_offerings(course_id)').eq('student_id',own.id).eq('pass_status','PASS').in('result_status',['PUBLISHED','LOCKED']);if(passed.error)throw passed.error;
  const completed=new Set((passed.data??[]).map((x:any)=>x.course_offerings?.course_id));
  const eligibleCourseIds=(sharedCoursesResult.data??[]).filter((c:Row)=>String(c.level)===String(own.current_level)&&!completed.has(c.id)).map((c:Row)=>c.id);
  const programmeId = current?.programme_id || own.programme_id;
  let offerings: Row[] = [];
  if (current && eligibleCourseIds.length && own.student_status==='ACTIVE' && !['PROGRESSION_PENDING','ACADEMIC_HOLD','COMPLETION_READY'].includes(own.progression_state)) {
    let query: any = db.from("course_offerings").select("*").in("course_id", eligibleCourseIds).in("status", ["OPEN","CLOSED"]);
    if (current?.academic_year_id) query = query.eq("academic_year_id", current.academic_year_id);
    if (current?.semester_id) query = query.eq("semester_id", current.semester_id);
    const result = await query.order("offering_code").limit(500);
    if (result.error) throw result.error;
    const isShared = new Set(sharedCourseIds);
    const mappingsByCourse = new Map(curriculumRows.map((row: Row) => [row.course_id, row]));
    const allowed = (result.data ?? []).filter((row: Row) => row.programme_id===own.programme_id&&row.programme_version_id===own.programme_version_id);
    const groups = new Map<string, Row[]>();
    for (const row of allowed) groups.set(row.course_id, [...(groups.get(row.course_id) ?? []), row]);
    offerings = [...groups.entries()].map(([courseId, rows]) => {
      rows.sort((a, b) => Number(b.programme_id === programmeId) - Number(a.programme_id === programmeId) || Number(b.status === "OPEN") - Number(a.status === "OPEN") || String(a.offering_code).localeCompare(String(b.offering_code)));
      const mapping = mappingsByCourse.get(courseId) ?? {};
      return { ...rows[0], credit_units: mapping.credit_units, course_category: mapping.course_category, year_number: mapping.year_number, semester_number: mapping.semester_number, is_compulsory: mapping.is_compulsory, is_cross_cutting: isShared.has(courseId) };
    });
  }
  const coursesResult = offerings.length ? await db.from("courses").select("*").in("id", [...new Set(offerings.map((o: Row) => o.course_id))]) : { data: [], error: null };
  if (coursesResult.error) throw coursesResult.error;
  const selectedResult = current ? await db.from("course_registrations").select("*").eq("student_registration_id", current.id).order("created_at") : { data: [], error: null };
  if (selectedResult.error) throw selectedResult.error;
  const requestsResult = current ? await db.from("course_add_drop_requests").select("*").eq("student_registration_id", current.id).order("requested_at", { ascending: false }) : { data: [], error: null };
  if (requestsResult.error) throw requestsResult.error;
  const [programme, year, semester] = await Promise.all([
    programmeId ? db.from("programmes").select("id,programme_code,programme_name").eq("id", programmeId).maybeSingle() : Promise.resolve({ data:null, error:null }),
    current?.academic_year_id ? db.from("academic_years").select("id,year_code,year_name").eq("id", current.academic_year_id).maybeSingle() : Promise.resolve({ data:null, error:null }),
    current?.semester_id ? db.from("semesters").select("id,semester_code,semester_name").eq("id", current.semester_id).maybeSingle() : Promise.resolve({ data:null, error:null }),
  ]);
  for (const result of [programme, year, semester]) if (result.error) throw result.error;
  return { student: own, registration_context: { programme:programme.data, academic_year:year.data, semester:semester.data, minimum_credits:current?.minimum_credits ?? null, maximum_credits:current?.maximum_credits ?? null, total_registered_credits:current?.total_registered_credits ?? 0 }, registrations: registrations.data ?? [], current_registration: current, offerings, courses: coursesResult.data ?? [], selected_courses: selectedResult.data ?? [], add_drop_requests: requestsResult.data ?? [] };
}));

router.post("/student/registration/select", requirePermission("students.registration.manage_own"), handle(async req => {
  const db = getSupabase(); const own = await student(req); const offeringId = text(req.body?.courseOfferingId, 80);
  if (!offeringId) throw httpError("Course offering is required.", 400);
  const regResult = await db.from("student_registrations").select("*").eq("student_id", own.id).in("registration_status", ["DRAFT","ELIGIBLE","REGISTERED"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (regResult.error) throw regResult.error;
  if (!regResult.data) throw httpError("No active registration is available for this student.", 409);
  const registration = regResult.data;
  const offeringResult = await db.from("course_offerings").select("*").eq("id", offeringId).eq("academic_year_id", registration.academic_year_id).eq("semester_id", registration.semester_id).maybeSingle();
  if (offeringResult.error) throw offeringResult.error;
  if (!offeringResult.data) throw httpError("This offering does not belong to the current academic year and semester.", 404);
  const programmeVersionId = registration.programme_version_id || own.programme_version_id;
  if (!programmeVersionId) throw httpError("Your programme version must be linked before selecting courses.", 409);
  if(!own.current_level||!own.curriculum_id||own.student_status!=='ACTIVE'||['PROGRESSION_PENDING','ACADEMIC_HOLD','COMPLETION_READY'].includes(own.progression_state)||registration.academic_year_id!==own.current_academic_year_id)throw httpError('Academic must reconcile your position and resolve progression blockers before course selection.',409);
  const curriculumIds=[own.curriculum_id];
  const [mappingResult, semesterResult, courseFlags] = await Promise.all([
    db.from("curriculum_courses").select("course_id,credit_units,year_number,semester_number,course_category,is_compulsory").in("curriculum_id", curriculumIds).eq("course_id", offeringResult.data.course_id),
    db.from("semesters").select("semester_number").eq("id", registration.semester_id).single(),
    db.from("courses").select("id,level,cross_cutting,status").eq("id", offeringResult.data.course_id).single(),
  ]);
  for (const result of [mappingResult, semesterResult, courseFlags]) if (result.error) throw result.error;
  if (!semesterResult.data || !courseFlags.data || courseFlags.data.status !== "ACTIVE") throw httpError("Course/semester is not available.", 409);
  const mapped = periodMappings((mappingResult.data ?? []).filter((m:Row)=>m.year_number===own.current_year_number), Number(semesterResult.data.semester_number));
  if(String(courseFlags.data.level)!==String(own.current_level))throw httpError('Course level does not match your approved academic position.',409);
  if (!mapped.length) throw httpError("This course is not mapped to your active curriculum for this semester.", 409);
  const shared = new Set<string>(courseFlags.data.cross_cutting ? [courseFlags.data.id] : []);
  if (offeringResult.data.programme_id!==own.programme_id||offeringResult.data.programme_version_id!==own.programme_version_id) throw httpError("Offering does not match your programme version or mapped cross-cutting access.", 409);
  const offering = offeringResult.data; const now = Date.now();
  if (offering.status !== "OPEN" || (offering.registration_open_at && now < Date.parse(offering.registration_open_at)) || (offering.registration_close_at && now > Date.parse(offering.registration_close_at))) throw httpError("Registration is not open for this course offering.", 409);
  if (Number(offering.capacity) > 0) {
    const count = await db.from("course_registrations").select("id", { count: "exact", head: true }).eq("course_offering_id", offering.id).in("registration_status", ["SELECTED","PENDING_APPROVAL","APPROVED","REGISTERED"]);
    if (count.error) throw count.error; if ((count.count ?? 0) >= Number(offering.capacity)) throw httpError("This course offering is full.", 409);
  }
  const courseResult = await db.from("courses").select("id,credit_units").eq("id", offering.course_id).single();
  if (courseResult.error) throw courseResult.error;
  if (!courseResult.data) throw httpError("Course master record was not found.", 404);
  let courseCredits = Number(courseResult.data.credit_units || 0);
  if (mapped[0]?.credit_units != null) courseCredits = Number(mapped[0].credit_units);
  const prerequisiteResult = await db.from("course_prerequisites").select("prerequisite_course_id,minimum_grade").eq("course_id", offering.course_id);
  if (prerequisiteResult.error) throw prerequisiteResult.error;
  const prerequisites = prerequisiteResult.data ?? [];
  if (prerequisites.length) {
    const passedResults = await db.from("course_results").select("course_offering_id,grade_code,pass_status,result_status").eq("student_id", own.id).eq("pass_status", "PASS").in("result_status", ["APPROVED","PUBLISHED","LOCKED"]);
    if (passedResults.error) throw passedResults.error;
    const passedOfferingIds = (passedResults.data ?? []).map((item: Row) => item.course_offering_id);
    const passedOfferings = passedOfferingIds.length ? await db.from("course_offerings").select("id,course_id").in("id", passedOfferingIds) : { data: [], error: null };
    if (passedOfferings.error) throw passedOfferings.error;
    const passedCourseIds = new Set((passedOfferings.data ?? []).map((item: Row) => item.course_id));
    const missing = prerequisites.filter((item: Row) => !passedCourseIds.has(item.prerequisite_course_id));
    if (missing.length) throw httpError("Course prerequisites have not been passed. Contact the Academic Office if an override is required.", 409);
  }
  const projectedCredits = Number(registration.total_registered_credits || 0) + courseCredits;
  if (projectedCredits > Number(registration.maximum_credits || 0)) throw httpError(`Selecting this course would exceed the maximum of ${registration.maximum_credits} credits.`, 409);
  const courseRegistrationStatus = registration.registration_status === "REGISTERED" ? "REGISTERED" : "SELECTED";
  const insert = await db.from("course_registrations").insert({ student_registration_id: registration.id, student_id: own.id, course_id: offering.course_id, course_offering_id: offering.id, credits: courseCredits, is_core: mapped[0]?.course_category === "CORE", is_elective: mapped[0]?.course_category === "ELECTIVE", registration_status: courseRegistrationStatus, prerequisite_status: prerequisites.length ? "PASSED" : "NOT_REQUIRED", eligibility_status: "ELIGIBLE", created_by: userId(req), updated_by: userId(req) }).select().single();
  if (insert.error?.code === "23505") throw httpError("This course is already selected.", 409);
  if (insert.error) throw insert.error;
  const selected = await db.from("course_registrations").select("credits").eq("student_registration_id", registration.id).not("registration_status", "in", "(DROPPED,REJECTED,CANCELLED)");
  if (selected.error) throw selected.error;
  const total = (selected.data ?? []).reduce((sum: number, item: Row) => sum + Number(item.credits || 0), 0);
  const parentUpdate = await db.from("student_registrations").update({ total_registered_credits: total, updated_by: userId(req), updated_at: new Date().toISOString() }).eq("id", registration.id);
  if (parentUpdate.error) throw parentUpdate.error;
  return { course_registration: insert.data, total_registered_credits: total };
}));

router.post("/student/registration/submit", requirePermission("students.registration.manage_own"), handle(async req => {
  const db = getSupabase(); const own = await student(req);
  const result = await db.from("student_registrations").select("*").eq("student_id", own.id).in("registration_status", ["DRAFT","ELIGIBLE"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw httpError("No editable registration is available for submission.", 409);
  const reg = result.data; const credits = Number(reg.total_registered_credits || 0);
  if (credits < Number(reg.minimum_credits || 0) || credits > Number(reg.maximum_credits || 0)) throw httpError(`Registered credits must be between ${reg.minimum_credits} and ${reg.maximum_credits}.`, 409);
  const selected = await db.from("course_registrations").select("id", { count: "exact", head: true }).eq("student_registration_id", reg.id).eq("registration_status", "SELECTED");
  if (selected.error) throw selected.error; if (!selected.count) throw httpError("Select at least one course before submission.", 409);
  const now = new Date().toISOString();
  const courses = await db.from("course_registrations").update({ registration_status: "PENDING_APPROVAL", updated_by: userId(req), updated_at: now }).eq("student_registration_id", reg.id).eq("registration_status", "SELECTED");
  if (courses.error) throw courses.error;
  const updated = await db.from("student_registrations").update({ registration_status: "SUBMITTED", submitted_at: now, updated_by: userId(req), updated_at: now }).eq("id", reg.id).select().single();
  if (updated.error) throw updated.error; return updated.data;
}));

router.post("/student/registration/add-drop", requirePermission("students.registration.manage_own"), handle(async req => {
  const db = getSupabase(); const own = await student(req); const type = String(req.body?.requestType ?? "").toUpperCase();
  const offeringId = text(req.body?.courseOfferingId, 80); const reason = text(req.body?.reason, 2000);
  if (!offeringId || !reason || !["ADD","DROP"].includes(type)) throw httpError("Offering, ADD/DROP type and reason are required.", 400);
  const reg = await db.from("student_registrations").select("*").eq("student_id", own.id).in("registration_status", ["APPROVED","REGISTERED","LOCKED"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (reg.error) throw reg.error;
  if (!reg.data) throw httpError("No registered semester is available for add/drop.", 409);
  const offering = await db.from("course_offerings").select("id,course_id").eq("id", offeringId).maybeSingle();
  if (offering.error) throw offering.error;
  if (!offering.data) throw httpError("Course offering was not found.", 404);
  const inserted = await db.from("course_add_drop_requests").insert({ student_registration_id: reg.data.id, student_id: own.id, course_id: offering.data.course_id, course_offering_id: offeringId, request_type: type, reason, requested_by: userId(req), request_status: "PENDING" }).select().single();
  if (inserted.error) throw inserted.error; return inserted.data;
}));

router.get("/student/payments", requirePermission("students.self.view"), handle(async req => {
  const own = await student(req); const result = await getSupabase().from("student_payment_requests").select("*").eq("student_id", own.id).order("requested_at", { ascending: false });
  if (result.error) throw result.error; return result.data ?? [];
}));
router.post("/student/payments/control-number", requirePermission("students.payments.request_own"), handle(async req => {
  const db = getSupabase(); const own = await student(req); const invoiceId = text(req.body?.invoiceId, 80); const phone = text(req.body?.payerPhone, 50);
  if (!invoiceId) throw httpError("Invoice is required.", 400);
  const invoice = await db.from("invoices").select("*").eq("id", invoiceId).eq("student_id", own.id).maybeSingle();
  if (invoice.error) throw invoice.error;
  if (!invoice.data) throw httpError("Invoice does not belong to the authenticated student.", 404);
  const amount = Number(invoice.data.balance_amount ?? invoice.data.total_amount ?? 0); if (!(amount > 0)) throw httpError("This invoice has no outstanding amount.", 409);
  const requestNumber = `PAY-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomUUID().slice(0,8).toUpperCase()}`;
  const inserted = await db.from("student_payment_requests").insert({ student_id: own.id, invoice_id: invoiceId, request_number: requestNumber, amount, payer_phone: phone, requested_by: userId(req), provider_message: "Awaiting configured payment provider. No payment has been recorded." }).select().single();
  if (inserted.error?.code === "23505") throw httpError("An open control-number request already exists for this invoice.", 409);
  if (inserted.error) throw inserted.error;
  return inserted.data;
}));

router.post("/student/documents/upload", requirePermission("students.self.manage"), express.raw({ type: "application/octet-stream", limit: "6mb" }), handle(async req => {
  const db = getSupabase(); const own = await student(req); const body = req.body as Buffer;
  const fileName = text(req.headers["x-file-name"], 255)?.replace(/[^a-zA-Z0-9._-]/g, "_"); const documentType = text(req.headers["x-document-type"], 100);
  const mimeType = text(req.headers["x-mime-type"], 100) || "application/octet-stream";
  const allowed = ["application/pdf","image/jpeg","image/png","image/webp"];
  if (!Buffer.isBuffer(body) || !body.length || !fileName || !documentType) throw httpError("Document type, file name and file content are required.", 400);
  if (!allowed.includes(mimeType)) throw httpError("Only PDF, JPG, PNG and WEBP files are allowed.", 400);
  if (!privateDocumentMatchesMime(body, mimeType)) throw httpError("Document contents do not match the selected file type.", 400);
  const path = `students/${own.id}/${Date.now()}-${randomUUID().slice(0,8)}-${fileName}`;
  const upload = await db.storage.from("idmc-private-documents").upload(path, body, { contentType: mimeType, upsert: false });
  if (upload.error) throw upload.error;
  const saved = await db.from("student_documents").insert({ student_id: own.id, document_type: documentType.toUpperCase(), file_name: fileName, mime_type: mimeType, file_url: path, verification_status: "PENDING" }).select().single();
  if (saved.error) { await db.storage.from("idmc-private-documents").remove([path]); throw saved.error; }
  return saved.data;
}));

router.get("/staff/me", handle(async req => {
  const db = getSupabase(); const own = await staff(req);
  const [types, balances, requests, payroll, attendance, documents] = await Promise.all([
    db.from("staff_leave_types").select("*").eq("institution_id", own.institution_id).eq("status", "ACTIVE").order("leave_name"),
    db.from("staff_leave_balances").select("*").eq("staff_id", own.id).order("leave_year", { ascending: false }),
    db.from("staff_leave_requests").select("*").eq("staff_id", own.id).order("created_at", { ascending: false }),
    db.from("staff_payroll_entries").select("*,payroll_periods(*)").eq("staff_id", own.id).in("status", ["APPROVED","PAID"]).order("created_at", { ascending: false }),
    db.from("staff_attendance").select("*").eq("staff_id", own.id).order("attendance_date", { ascending: false }).limit(100),
    db.from("staff_documents").select("*").eq("staff_id", own.id).order("created_at", { ascending: false }),
  ]);
  for (const result of [types, balances, requests, payroll, attendance, documents]) if (result.error) throw result.error;
  return { staff: own, leave_types: types.data ?? [], leave_balances: balances.data ?? [], leave_requests: requests.data ?? [], payroll: payroll.data ?? [], attendance: attendance.data ?? [], documents: documents.data ?? [] };
}));
router.patch("/staff/me/profile", requirePermission("staff.self.manage"), handle(async req => {
  const db = getSupabase(); const own = await staff(req);
  const payload = { phone: text(req.body?.phone,50), physical_address: text(req.body?.physicalAddress,1000), postal_address: text(req.body?.postalAddress,1000), emergency_contact_name: text(req.body?.emergencyContactName,200), emergency_contact_phone: text(req.body?.emergencyContactPhone,50), updated_by: userId(req), updated_at: new Date().toISOString() };
  const result = await db.from("staff").update(payload).eq("id", own.id).select().single(); if (result.error) throw result.error; return result.data;
}));
router.post("/staff/me/leave", requirePermission("staff.self.manage"), handle(async req => {
  const db = getSupabase(); const own = await staff(req); const leaveTypeId = text(req.body?.leaveTypeId,80); const start = text(req.body?.startDate,10); const end = text(req.body?.endDate,10); const reason = text(req.body?.reason,2000);
  if (!leaveTypeId || !start || !end || !reason) throw httpError("Leave type, start date, end date and reason are required.", 400);
  const startAt = new Date(`${start}T00:00:00Z`); const endAt = new Date(`${end}T00:00:00Z`); if (!Number.isFinite(startAt.getTime()) || endAt < startAt) throw httpError("Leave date range is invalid.", 400);
  const days = Math.floor((endAt.getTime() - startAt.getTime()) / 86_400_000) + 1;
  const balance = await db.from("staff_leave_balances").select("available_balance").eq("staff_id", own.id).eq("leave_type_id", leaveTypeId).eq("leave_year", startAt.getUTCFullYear()).maybeSingle();
  if (balance.error) throw balance.error; if (balance.data && Number(balance.data.available_balance) < days) throw httpError("Requested days exceed the available leave balance.", 409);
  const requestNumber = `LV-${startAt.getUTCFullYear()}-${randomUUID().slice(0,8).toUpperCase()}`;
  const result = await db.from("staff_leave_requests").insert({ staff_id: own.id, leave_type_id: leaveTypeId, leave_year: startAt.getUTCFullYear(), request_number: requestNumber, start_date: start, end_date: end, days_requested: days, reason, request_status: "PENDING", submitted_at: new Date().toISOString(), created_by: userId(req), updated_by: userId(req) }).select().single();
  if (result.error) throw result.error; return result.data;
}));

export default router;
