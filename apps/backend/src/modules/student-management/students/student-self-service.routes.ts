import { Router, type NextFunction, type Request, type Response } from "express";
import { institutionDb } from "../../institution-management/shared/institution-db.js";
import { env } from "../../../config/env.js";
import { requirePermission } from "../../../middleware/rbac.js";
import { privateStorageObjectPath } from "../../../utils/private-storage-path.js";
import {
  changeOwnPassword,
  getStudentPortal,
  respondToCoursework,
  submitCourseEvaluation,
  submitHelpdeskTicket,
  submitServiceRequest,
  updateOwnProfile,
} from "./student-self-service.service.js";
import { getMyStudentRecord } from "./students.service.js";
import { StudentSelfServiceError } from "./student-self-service.errors.js";

type Row = Record<string, any>;
const router = Router();

function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await action(req) });
    } catch (error) {
      next(error);
    }
  };
}

function latest(records: Row[]): Row | null {
  return records[0] ?? null;
}

async function portal(req: Request): Promise<Row> {
  return await getStudentPortal(req) as Row;
}

router.get("/portal", requirePermission("students.self.view"), handle(portal));

router.get("/summary", requirePermission("students.self.view"), handle(async req => {
  // Keep the landing page small: the full portal fetches dozens of tables and
  // can exceed Cloudflare's per-invocation subrequest limit.
  const student = await ownStudent(req);
  const studentId = String(student.id);
  const reads = await Promise.all([
    institutionDb.from("student_registrations").select("*").eq("student_id", studentId).order("created_at", { ascending: false }).limit(5),
    institutionDb.from("attendance_records").select("id,attendance_status").eq("student_id", studentId).limit(500),
    institutionDb.from("student_semester_results").select("*").eq("student_id", studentId).order("created_at", { ascending: false }).limit(5),
    institutionDb.from("student_cgpa_records").select("*").eq("student_id", studentId).order("calculated_at", { ascending: false }).limit(5),
    institutionDb.from("student_financial_accounts").select("*").eq("student_id", studentId).maybeSingle(),
    institutionDb.from("student_academic_deficiencies").select("id").eq("student_id", studentId).limit(200),
    institutionDb.from("course_results").select("id,pass_status,result_status").eq("student_id", studentId).limit(500),
    institutionDb.from("notifications").select("id,read_at,status").eq("recipient_student_id", studentId).order("created_at", { ascending: false }).limit(100),
    institutionDb.from("student_service_requests").select("id,status").eq("student_id", studentId).limit(100),
    institutionDb.from("course_registrations").select("id,course_id,course_offering_id,registration_status").eq("student_id", studentId).limit(100),
    institutionDb.from("student_documents").select("id").eq("student_id", studentId).limit(100),
    student.user_id ? institutionDb.from("users").select("last_login_at").eq("id", student.user_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    institutionDb.from("announcements").select("id,title,summary,body,publish_at").eq("status", "PUBLISHED").order("publish_at", { ascending: false }).limit(5),
  ]);
  const labels = ["registrations", "attendance", "semester results", "CGPA", "financial account", "academic deficiencies", "course results", "notifications", "service requests", "course registrations", "student documents", "login history", "announcements"];
  for (let index = 0; index < reads.length; index++) {
    if (reads[index].error) throw new Error(`Unable to load student ${labels[index]}: ${reads[index].error.message}`);
  }
  const [registrationRows, attendanceRows, semesterRows, cgpaRows, accountResult, deficiencyRows, resultRows, notificationRows, requestRows, courseRegistrationRows, documentRows, loginResult, announcementResult] = reads;
  const registrations = registrationRows.data ?? [];
  const registration = registrations[0] ?? null;
  const attendance = attendanceRows.data ?? [];
  const semester = semesterRows.data?.[0] ?? null;
  const cgpa = cgpaRows.data?.[0] ?? null;
  const account = accountResult.data ?? {};
  const deficiencies = deficiencyRows.data ?? [];
  const courseResults = resultRows.data ?? [];
  const notifications = notificationRows.data ?? [];
  const requests = requestRows.data ?? [];
  const courseRegistrations = courseRegistrationRows.data ?? [];
  const balance = Number(account.balance ?? account.outstanding_balance ?? account.current_balance ?? account.account_balance ?? 0);

  let yearName = null;
  const yearId = registration?.academic_year_id ?? student.current_academic_year_id;
  if (yearId) {
    const yearResult = await institutionDb.from("academic_years").select("year_name,year_code").eq("id", yearId).maybeSingle();
    if (!yearResult.error) yearName = yearResult.data?.year_name ?? yearResult.data?.year_code ?? null;
  }

  const offeringIds = [...new Set(courseRegistrations.map((row: Row) => row.course_offering_id).filter(Boolean))];
  let upcomingClasses: Row[] = [];
  if (offeringIds.length) {
    const timetableResult = await institutionDb.from("timetable_entries").select("*").in("course_offering_id", offeringIds).limit(100);
    if (!timetableResult.error && timetableResult.data?.length) {
      const timetableRows = timetableResult.data;
      const [offeringsResult, slotsResult, roomsResult] = await Promise.all([
        institutionDb.from("course_offerings").select("id,course_id,offering_code").in("id", offeringIds),
        institutionDb.from("timetable_slots").select("*").in("id", timetableRows.map((row: Row) => row.timetable_slot_id).filter(Boolean)),
        institutionDb.from("rooms").select("id,room_name,room_code").in("id", timetableRows.map((row: Row) => row.room_id).filter(Boolean)),
      ]);
      const offerings = offeringsResult.data ?? [];
      const courseIds = [...new Set(offerings.map((row: Row) => row.course_id).filter(Boolean))];
      const coursesResult = courseIds.length ? await institutionDb.from("courses").select("id,course_code,course_name").in("id", courseIds) : { data: [], error: null };
      const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));
      const offeringMap = byId(offerings);
      const slotMap = byId(slotsResult.data ?? []);
      const roomMap = byId(roomsResult.data ?? []);
      const courseMap = byId(coursesResult.data ?? []);
      upcomingClasses = timetableRows.map((row: Row) => {
        const offering = offeringMap.get(row.course_offering_id) ?? {};
        const course = courseMap.get(offering.course_id) ?? {};
        return { ...row, ...course, offering_code: offering.offering_code ?? null, slot: slotMap.get(row.timetable_slot_id) ?? null, room: roomMap.get(row.room_id) ?? null };
      });
    }
  }

  const attended = attendance.filter((row: Row) => ["PRESENT", "LATE"].includes(String(row.attendance_status).toUpperCase())).length;
  const unread = notifications.filter((row: Row) => !row.read_at && String(row.status ?? "").toUpperCase() !== "READ");
  const pending = requests.filter((row: Row) => !["APPROVED", "REJECTED", "CLOSED", "CANCELLED"].includes(String(row.status).toUpperCase()));
  const failed = courseResults.filter((row: Row) => String(row.pass_status).toUpperCase() === "FAIL");
  const published = courseResults.filter((row: Row) => ["PUBLISHED", "LOCKED"].includes(String(row.result_status).toUpperCase()));
  const currentYear = Number(student.current_year_number);
  const yearOfStudy = Number.isFinite(currentYear) && currentYear > 0 ? `${currentYear}${currentYear % 100 >= 11 && currentYear % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[currentYear % 10] ?? "th"} Year` : null;
  const entryYear = Number(student.admission_year ?? String(student.admission_date ?? student.enrollment_date ?? "").slice(0, 4));
  const programme = Array.isArray(student.programmes) ? student.programmes[0] : student.programmes;
  const alerts: Row[] = [];
  if (!registration) alerts.push({ severity: "warning", title: "No semester registration", message: "Contact the Academic Office to create the current registration." });
  if (balance > 0) alerts.push({ severity: "warning", title: "Outstanding balance", message: `Your account has an outstanding balance of ${balance}.` });
  if (deficiencies.length || failed.length) alerts.push({ severity: "danger", title: "Academic action required", message: `${deficiencies.length || failed.length} course item(s) require attention.` });
  if (unread.length) alerts.push({ severity: "info", title: "Unread notifications", message: `${unread.length} notification(s) have not been read.` });

  return {
    student: { ...student, programme_name: student.programme_name ?? programme?.programme_name ?? null, programme_code: student.programme_code ?? programme?.programme_code ?? null },
    panel: { current_year: yearName ?? registration?.academic_year_name ?? null, last_login_at: loginResult.data?.last_login_at ?? null, year_of_study: yearOfStudy, year_of_study_number: Number.isFinite(currentYear) ? currentYear : null, stream: null, student_status: student.student_status ?? student.status ?? null, entry_year: Number.isFinite(entryYear) && entryYear > 0 ? `${entryYear}/${entryYear + 1}` : null, intake: null, session: student.mode_of_study ?? programme?.mode_of_study ?? null, programme: student.programme_name ?? programme?.programme_name ?? null, programme_code: student.programme_code ?? programme?.programme_code ?? null, department: null, school: null, campus: null },
    current_registration: registration,
    latest_result: { gpa: semester?.gpa ?? null, cgpa: cgpa?.cgpa ?? semester?.cgpa ?? null, academic_standing: semester?.academic_standing ?? cgpa?.academic_standing ?? null },
    attendance: { total: attendance.length, attended, percentage: attendance.length ? Number(((attended / attendance.length) * 100).toFixed(1)) : null },
    finance: { balance, account_status: account.account_status ?? null, currency: account.currency_code ?? "TZS" },
    counts: { registered_courses: courseRegistrations.filter((row: Row) => !["DROPPED", "REJECTED", "CANCELLED"].includes(String(row.registration_status).toUpperCase())).length, published_results: published.length, documents: documentRows.data?.length ?? 0, unread_notifications: unread.length, pending_requests: pending.length, deficiencies: deficiencies.length, failed_courses: failed.length },
    academic_risk: deficiencies.length || failed.length ? "AT_RISK" : (semester?.academic_standing ?? "GOOD"),
    alerts,
    upcoming_classes: upcomingClasses,
    upcoming_examinations: [],
    announcements: announcementResult.data ?? [],
    audit_warnings: [],
  };
}));
router.get("/registration", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return {
    student: data.student,
    registrations: data.registrations ?? [],
    current_registration: latest(data.registrations ?? []),
    course_registrations: data.course_registrations ?? [],
    course_offerings: data.course_offerings ?? [],
    courses: data.courses ?? [],
    audit_warnings: data.audit_warnings ?? [],
  };
}));

router.get("/results", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return {
    course_results: (data.course_results ?? []).filter((item: Row) => ["PUBLISHED", "LOCKED"].includes(String(item.result_status).toUpperCase())),
    semester_results: (data.semester_results ?? []).filter((item: Row) => ["PUBLISHED", "LOCKED", "APPROVED"].includes(String(item.result_status ?? item.status).toUpperCase())),
    cgpa_records: data.cgpa_records ?? [],
    deficiencies: data.academic_deficiencies ?? [],
  };
}));

router.get("/attendance", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return { records: data.attendance_records ?? [] };
}));

router.get("/timetable", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return { classes: data.timetable_entries ?? [], examinations: data.examination_timetable ?? [] };
}));

router.get("/finance", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  const student = await getMyStudentRecord(req) as Row;
  const paymentRequests = await institutionDb.from("student_payment_requests").select("*").eq("student_id", student.id).order("requested_at", { ascending: false });
  if (paymentRequests.error) throw new Error(`Unable to load payment requests: ${paymentRequests.error.message}`);
  return { account: data.financial_account, invoices: data.invoices ?? [], payments: data.payments ?? [], transactions: data.financial_transactions ?? [], scholarships: data.scholarships ?? [], payment_requests: paymentRequests.data ?? [] };
}));

router.get("/documents", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return { documents: data.student_documents ?? [], service_requests: data.service_requests ?? [] };
}));

router.get("/documents/:id/download", requirePermission("students.self.view"), handle(async req => {
  const student = await getMyStudentRecord(req) as Row;
  const result = await institutionDb.from("student_documents").select("*").eq("id", req.params.id).eq("student_id", student.id).maybeSingle();
  if (result.error || !result.data) throw new StudentSelfServiceError("Document was not found for the authenticated student.", 404);
  const path = privateStorageObjectPath(result.data.file_url || result.data.file_path, env.SUPABASE_URL, `students/${student.id}/`);
  if (!path) throw new StudentSelfServiceError("Document storage path is invalid or unavailable.", 404);
  const signed = await institutionDb.storage.from("idmc-private-documents").createSignedUrl(path, 300);
  if (signed.error) throw new Error(`Unable to prepare document download: ${signed.error.message}`);
  return { url: signed.data.signedUrl, expires_in: 300, file_name: result.data.file_name };
}));

router.get("/notifications", requirePermission("students.self.view"), handle(async req => {
  const data = await portal(req);
  return { notifications: data.notifications ?? [], announcements: data.announcements ?? [] };
}));

router.patch("/notifications/:id/read", requirePermission("students.self.manage"), handle(async req => {
  const student = await getMyStudentRecord(req) as Row;
  const now = new Date().toISOString();
  const result = await institutionDb.from("notifications").update({ status: "READ", read_at: now }).eq("id", req.params.id).eq("recipient_student_id", student.id).select().maybeSingle();
  if (result.error || !result.data) throw new StudentSelfServiceError("Notification was not found for the authenticated student.", 404);
  return result.data;
}));

router.post("/notifications/read-all", requirePermission("students.self.manage"), handle(async req => {
  const student = await getMyStudentRecord(req) as Row;
  const result = await institutionDb.from("notifications").update({ status: "READ", read_at: new Date().toISOString() }).eq("recipient_student_id", student.id).is("read_at", null).select("id");
  if (result.error) throw new Error(`Unable to update notifications: ${result.error.message}`);
  return { updated: result.data?.length ?? 0 };
}));

router.get("/transcript", requirePermission("students.self.view"), handle(async req => {
  const student = await getMyStudentRecord(req) as Row;
  const transcripts = await institutionDb.from("student_transcripts").select("*").eq("student_id", student.id).order("created_at", { ascending: false });
  if (transcripts.error) throw new Error(`Unable to load transcript: ${transcripts.error.message}`);
  const transcript = transcripts.data?.[0] ?? null;
  if (!transcript) return { student, transcript: null, semesters: [], courses: [] };
  const [semesters, courses] = await Promise.all([
    institutionDb.from("student_transcript_semesters").select("*").eq("transcript_id", transcript.id).order("sequence_no"),
    institutionDb.from("student_transcript_courses").select("*").eq("transcript_id", transcript.id).order("display_sequence"),
  ]);
  if (semesters.error) throw new Error(`Unable to load transcript semesters: ${semesters.error.message}`);
  if (courses.error) throw new Error(`Unable to load transcript courses: ${courses.error.message}`);
  return { student, transcript, semesters: semesters.data ?? [], courses: courses.data ?? [], history: transcripts.data ?? [] };
}));

router.patch("/profile", requirePermission("students.self.manage"), handle(req => updateOwnProfile(req, req.body ?? {})));
router.post("/coursework-responses", requirePermission("students.self.manage"), handle(req => respondToCoursework(req, req.body ?? {})));
router.post("/course-evaluations", requirePermission("students.self.manage"), handle(req => submitCourseEvaluation(req, req.body ?? {})));
router.post("/requests", requirePermission("students.self.manage"), handle(req => submitServiceRequest(req, req.body ?? {})));
router.post("/helpdesk", requirePermission("students.self.manage"), handle(req => submitHelpdeskTicket(req, req.body ?? {})));
router.post("/change-password", requirePermission("students.self.manage"), handle(req => changeOwnPassword(req, req.body ?? {})));

export default router;
