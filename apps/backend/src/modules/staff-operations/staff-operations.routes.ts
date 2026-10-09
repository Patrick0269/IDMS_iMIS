import { Router, type NextFunction, type Request, type Response } from "express";
import { getSupabase } from "../../config/database.js";
import { scopeRoleAssignments } from "../../utils/security.js";
import { authenticate } from "../../middleware/auth.js";
import { httpError } from "../../utils/httpError.js";

type Row = Record<string, any>;
type Scope = { field: string; values: string[] };
type Queue = { table: string; label: string; order: string; columns: string[]; scope: Scope[] };

const router = Router();
router.use(authenticate);

const groups: Record<string, string[]> = {
  hr: ["HR_OFFICER"], admissions: ["ADMISSIONS_OFFICER"],
  examinations: ["EXAMINATION_OFFICER", "EXAMINATIONS_OFFICER", "EXAM_OFFICER"],
  library: ["LIBRARIAN"], operations: ["PROCUREMENT_OFFICER", "STORE_OFFICER", "OPERATIONS_OFFICER"],
  academic: ["HOD", "DEPUTY_HOD", "ACADEMIC_OFFICER", "REGISTRAR"],
  communications: ["COMMUNICATIONS_OFFICER", "HELPDESK_OFFICER", "DOCUMENTS_OFFICER"],
  management: ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN", "REPORTS_OFFICER", "AUDITOR"],
};
const allowed = (codes: string[], group: string) => codes.some(code => (groups[group] ?? []).includes(code) || ["ADMIN", "SUPER_ADMIN"].includes(code));
const unique = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
function* scopeCombinations(scopes: Scope[], index = 0, selected: Scope[] = []): Generator<Scope[]> {
  if (index >= scopes.length) { yield selected; return; }
  const current = scopes[index]!;
  for (let offset = 0; offset < current.values.length; offset += 100) {
    yield* scopeCombinations(scopes, index + 1, [...selected, { field: current.field, values: current.values.slice(offset, offset + 100) }]);
  }
}

async function context(req: Request) {
  const db = getSupabase();
  const roleResult = await db.from("user_roles")
    .select("role_id,assigned_at,status,expires_at,roles!inner(role_code,status)")
    .eq("user_id", req.user!.id).eq("status", "ACTIVE");
  if (roleResult.error) throw roleResult.error;
  const scopedRoles = scopeRoleAssignments(roleResult.data, req.user!.activeRoleId);
  if (scopedRoles[0]?.role_id) req.user!.activeRoleId = scopedRoles[0].role_id;
  const codes = scopedRoles
    .filter((assignment: Row) => assignment.roles?.status === "ACTIVE" && (!assignment.expires_at || Date.parse(assignment.expires_at) > Date.now()))
    .map((assignment: Row) => String(assignment.roles.role_code));
  const staffResult = await db.from("staff")
    .select("id,institution_id,user_id,employee_number,first_name,last_name,job_title")
    .eq("user_id", req.user!.id).maybeSingle();
  if (staffResult.error) throw staffResult.error;
  const isAdmin = codes.some(code => ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"].includes(code));
  if (!staffResult.data && !isAdmin) throw httpError("Staff profile is not linked to this account.", 403);
  const institutionId = staffResult.data?.institution_id;
  if (!institutionId) throw httpError("A staff institution scope is required for this workspace.", 403);
  return { codes, staff: staffResult.data, institutionId: String(institutionId) };
}

async function idRows(table: string, columns: string[], scopes: Scope[]): Promise<Row[]> {
  if (!scopes.length || scopes.some(scope => !scope.values.length)) return [];
  const db = getSupabase(), result: Row[] = [];
  for (const combination of scopeCombinations(scopes)) {
    const query = db.from(table).select(["id", ...columns].join(","));
    for (const scope of combination) query.in(scope.field, scope.values);
    const response = await query.limit(Math.max(0, 5000 - result.length));
    if (response.error) throw response.error;
    result.push(...(response.data ?? []));
    if (result.length >= 5000) break;
  }
  return result.slice(0, 5000);
}

async function scopedRows(queue: Queue): Promise<Row[]> {
  if (queue.scope.some(scope => !scope.values.length)) return [];
  const db = getSupabase(), result: Row[] = [];
  for (const combination of scopeCombinations(queue.scope)) {
    const query = db.from(queue.table).select(["id", ...queue.columns].join(","));
    for (const scope of combination) query.in(scope.field, scope.values);
    const response = await query.order(queue.order, { ascending: false }).limit(Math.max(0, 80 - result.length));
    if (response.error) throw response.error;
    result.push(...(response.data ?? []));
    if (result.length >= 80) break;
  }
  return result.slice(0, 80).map(({ id: _id, ...row }) => row);
}

async function buildScope(institutionId: string) {
  const programmeRows = await idRows("programmes", [], [{ field: "institution_id", values: [institutionId] }]);
  const programmeIds = unique(programmeRows.map(row => row.id));
  const [staffRows, studentRows, offeringRows, memberRows, inventoryRows] = await Promise.all([
    idRows("staff", ["user_id"], [{ field: "institution_id", values: [institutionId] }]),
    idRows("students", ["user_id"], [{ field: "programme_id", values: programmeIds }]),
    idRows("course_offerings", [], [{ field: "programme_id", values: programmeIds }]),
    idRows("library_members", [], [{ field: "institution_id", values: [institutionId] }]),
    idRows("inventory_items", [], [{ field: "institution_id", values: [institutionId] }]),
  ]);
  const staffIds = unique(staffRows.map(row => row.id));
  const studentIds = unique(studentRows.map(row => row.id));
  const offeringIds = unique(offeringRows.map(row => row.id));
  const applicationChoices = await idRows("application_choices", ["application_id"], [{ field: "programme_id", values: programmeIds }]);
  const applicationIds = unique(applicationChoices.map(row => row.application_id));
  const paperRows = await idRows("examination_papers", ["examination_period_id"], [{ field: "course_offering_id", values: offeringIds }]);
  const paperIds = unique(paperRows.map(row => row.id));
  const candidateRows = await idRows("examination_candidates", [], [
    { field: "student_id", values: studentIds }, { field: "examination_paper_id", values: paperIds },
  ]);
  const candidateIds = unique(candidateRows.map(row => row.id));
  const markRows = await idRows("examination_marks", [], [{ field: "examination_candidate_id", values: candidateIds }]);
  const markIds = unique(markRows.map(row => row.id));
  const userIds = unique([...staffRows, ...studentRows].map(row => row.user_id));
  return {
    institutionId, staffIds, studentIds, programmeIds, offeringIds, applicationIds, paperIds, candidateIds, markIds,
    libraryMemberIds: unique(memberRows.map(row => row.id)), inventoryItemIds: unique(inventoryRows.map(row => row.id)), userIds,
  };
}

router.get("/overview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = await context(req), scope = await buildScope(c.institutionId);
    const sections: Row[] = [], warnings: string[] = [];
    const add = async (code: string, title: string, link: string, queues: Queue[]) => {
      const output = [];
      for (const queue of queues) {
        try { output.push({ table: queue.table, label: queue.label, rows: await scopedRows(queue) }); }
        catch { warnings.push(`${queue.label} could not be loaded within the staff institution scope.`); output.push({ table: queue.table, label: queue.label, rows: [] }); }
      }
      sections.push({ code, title, link, queues: output });
    };
    const q = (table: string, label: string, order: string, columns: string[], ...filters: Scope[]): Queue => ({ table, label, order, columns, scope: filters });
    const institution = { field: "institution_id", values: [scope.institutionId] };
    const byStaff = { field: "staff_id", values: scope.staffIds };
    const byStudents = { field: "student_id", values: scope.studentIds };
    const byProgrammes = { field: "programme_id", values: scope.programmeIds };
    const byOfferings = { field: "course_offering_id", values: scope.offeringIds };
    const byApplications = { field: "application_id", values: scope.applicationIds };
    const byPapers = { field: "examination_paper_id", values: scope.paperIds };
    const byCandidates = { field: "examination_candidate_id", values: scope.candidateIds };
    const byMarks = { field: "examination_mark_id", values: scope.markIds };
    const byLibraryMembers = { field: "library_member_id", values: scope.libraryMemberIds };
    const byInventory = { field: "inventory_item_id", values: scope.inventoryItemIds };
    const byUsers = { field: "user_id", values: scope.userIds };

    if (allowed(c.codes, "hr")) await add("hr", "Human Resources", "hr.html", [
      q("staff_leave_requests", "Pending Leave", "created_at", ["request_number", "request_status", "start_date", "end_date", "days_requested"], byStaff),
      q("staff", "Staff Register", "created_at", ["employee_number", "first_name", "last_name", "job_title", "employment_status"], institution),
      q("staff_attendance", "Recent Attendance", "attendance_date", ["attendance_date", "attendance_status", "check_in", "check_out"], byStaff),
      q("staff_payroll_entries", "Payroll Queue", "created_at", ["status", "currency_code", "paid_at", "payment_reference"], byStaff),
    ]);
    if (allowed(c.codes, "admissions")) await add("admissions", "Admissions", "admissions.html", [
      q("applications", "Application Queue", "created_at", ["application_number", "status", "verification_status", "eligibility_status", "submitted_at"], { field: "id", values: scope.applicationIds }),
      q("admission_decisions", "Decisions", "decision_date", ["decision_type", "decision_status", "decision_date"], byApplications),
      q("admission_offers", "Offers", "offer_date", ["offer_number", "offer_date", "expiry_date", "offer_status"], byApplications, byProgrammes),
    ]);
    if (allowed(c.codes, "examinations")) await add("examinations", "Examinations", "examinations.html", [
      q("examination_sessions", "Exam Sessions", "examination_date", ["session_code", "examination_date", "start_time", "end_time", "status"], byPapers),
      q("examination_candidates", "Candidate Eligibility", "created_at", ["candidate_number", "eligibility_status", "attendance_status", "candidate_status"], { field: "id", values: scope.candidateIds }),
      q("examination_marks", "Marks Queue", "updated_at", ["grade", "status", "updated_at"], { field: "id", values: scope.markIds }),
      q("examination_mark_corrections", "Corrections", "requested_at", ["requested_at", "status", "new_grade"], byMarks),
    ]);
    if (allowed(c.codes, "library")) await add("library", "Library Circulation", "library.html", [
      q("library_loans", "Loans", "loan_date", ["loan_number", "loan_date", "due_date", "loan_status"], byLibraryMembers),
      q("library_reservations", "Reservations", "created_at", ["reservation_date", "expiry_date", "reservation_status"], byLibraryMembers),
      q("library_fines", "Fines", "created_at", ["fine_type", "amount", "status", "created_at"], { field: "member_id", values: scope.libraryMemberIds }),
      q("library_items", "Catalogue", "created_at", ["accession_number", "title", "item_type", "available_copies", "item_status"], institution),
    ]);
    if (allowed(c.codes, "operations")) await add("operations", "Procurement & Stores", "operations.html", [
      q("procurement_requests", "Requisitions", "request_date", ["request_number", "request_date", "priority", "request_status"], institution),
      q("purchase_orders", "Purchase Orders", "order_date", ["purchase_order_number", "order_date", "order_status", "expected_delivery_date"], institution),
      q("inventory_items", "Inventory", "created_at", ["item_code", "item_name", "current_quantity", "reorder_level"], institution),
      q("inventory_transactions", "Stock Movements", "transaction_date", ["transaction_type", "transaction_date", "quantity", "reference_number"], byInventory),
    ]);
    if (allowed(c.codes, "academic")) await add("academic", "Academic Department", "programmes.html", [
      q("course_offerings", "Course Offerings", "created_at", ["offering_code", "section_name", "status", "registration_open_at"], byProgrammes),
      q("lecturer_assignments", "Teaching Load", "assigned_at", ["assignment_role", "workload_hours", "assignment_status", "assigned_at"], byOfferings),
      q("student_registrations", "Registrations", "created_at", ["registration_number", "registration_status", "academic_eligibility_status"], byStudents),
      q("course_results", "Results Queue", "updated_at", ["grade_code", "result_status", "updated_at"], byStudents),
    ]);
    if (allowed(c.codes, "communications")) await add("communications", "Communications & Helpdesk", "communications.html", [
      q("helpdesk_tickets", "Helpdesk Queue", "created_at", ["ticket_number", "subject", "status", "priority", "created_at"], institution),
      q("announcements", "Announcements", "created_at", ["title", "status", "published_at", "created_at"], institution),
      q("documents", "Document Registry", "created_at", ["document_number", "title", "document_type", "status", "created_at"], institution),
      q("notification_queue", "Notification Queue", "created_at", ["notification_type", "status", "created_at"], institution),
    ]);
    if (allowed(c.codes, "management")) await add("management", "Management Oversight", "reports.html", [
      q("students", "Students", "created_at", ["student_number", "student_status", "created_at"], { field: "id", values: scope.studentIds }),
      q("staff", "Staff", "created_at", ["employee_number", "first_name", "last_name", "employment_status"], institution),
      q("invoices", "Invoices", "created_at", ["invoice_number", "status", "total_amount", "balance_amount"], byStudents),
      q("payments", "Payments", "created_at", ["payment_number", "status", "payment_date", "amount"], byStudents),
      q("audit_logs", "Audit Activity", "created_at", ["action_code", "module_code", "entity_type", "created_at"], byUsers),
    ]);
    if (!sections.length) throw httpError("No operational workspace is assigned to your active role.", 403);
    res.json({ success: true, data: { user: req.user, staff: c.staff, roles: c.codes, sections, warnings: unique(warnings) } });
  } catch (error) { next(error); }
});

export default router;
