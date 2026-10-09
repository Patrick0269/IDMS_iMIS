import { Router, type Request, type Response, type NextFunction } from "express";
import { getSupabase } from "../../config/database.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";
import { rolesGrantRole, scopeRoleAssignments } from "../../utils/security.js";

type ImportRow = {
  regno?: unknown; academicYear?: unknown; semester?: unknown; courseCode?: unknown;
  coursework?: unknown; examination?: unknown; resultType?: unknown; remarks?: unknown;
};

const router = Router();
const MAX_ROWS = 5000;

function clean(value: unknown, max: number): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function mark(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function actor(req: Request): string {
  if (!req.user?.id) throw new Error("Authenticated user identity is unavailable.");
  return String(req.user.id);
}

async function assertLecturerImportScope(req: Request, sourceRows: Array<Record<string, unknown>>) {
  const userId = actor(req), db = getSupabase();
  const identity = await db.from("user_roles").select("role_id,assigned_at,status,expires_at,roles!inner(role_code,status)").eq("user_id", userId).eq("status", "ACTIVE");
  if (identity.error) throw identity.error;
  const roles = scopeRoleAssignments(identity.data, req.user?.activeRoleId);
  if (roles[0]?.role_id) req.user!.activeRoleId = roles[0].role_id;
  if (!rolesGrantRole(roles, ["LECTURER"]) || rolesGrantRole(roles, ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN", "HOD", "ACADEMIC_OFFICER", "EXAMINATION_OFFICER", "EXAM_OFFICER"])) return;
  const assignments = await db.from("lecturer_assignments").select("course_offering_id").eq("lecturer_user_id", userId).eq("assignment_status", "ACTIVE");
  if (assignments.error) throw assignments.error;
  const offeringIds = [...new Set((assignments.data ?? []).map(row => String(row.course_offering_id)))];
  if (!offeringIds.length) throw Object.assign(new Error("No active course offerings are assigned to your lecturer account."), { statusCode: 403 });
  const offerings = await db.from("course_offerings").select("id,course_id,academic_year_id,semester_id").in("id", offeringIds);
  if (offerings.error) throw offerings.error;
  const courseIds = [...new Set((offerings.data ?? []).map(row => String(row.course_id)))], yearIds = [...new Set((offerings.data ?? []).map(row => String(row.academic_year_id)))], semesterIds = [...new Set((offerings.data ?? []).map(row => String(row.semester_id)))];
  const [courses, years, semesters] = await Promise.all([
    courseIds.length ? db.from("courses").select("id,course_code").in("id", courseIds) : Promise.resolve({ data: [], error: null }),
    yearIds.length ? db.from("academic_years").select("id,year_code,year_name").in("id", yearIds) : Promise.resolve({ data: [], error: null }),
    semesterIds.length ? db.from("semesters").select("id,semester_code,semester_name").in("id", semesterIds) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [courses, years, semesters]) if (result.error) throw result.error;
  const normalized = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();
  const assignedCourses = (offerings.data ?? []).map(offering => {
    const course = (courses.data ?? []).find(row => row.id === offering.course_id), year = (years.data ?? []).find(row => row.id === offering.academic_year_id), semester = (semesters.data ?? []).find(row => row.id === offering.semester_id);
    return { course: normalized(course?.course_code), years: [normalized(year?.year_name), normalized(year?.year_code)], semesters: [normalized(semester?.semester_code), normalized(semester?.semester_name)] };
  });
  const mismatch = sourceRows.find(row => {
    const course = normalized(row.courseCode ?? row.course_code), year = normalized(row.academicYear ?? row.academic_year), semester = normalized(row.semester);
    return !assignedCourses.some(item => item.course === course && item.years.includes(year) && item.semesters.includes(semester));
  });
  if (mismatch) throw Object.assign(new Error(`Course ${String(mismatch.courseCode ?? mismatch.course_code ?? "")} / ${String(mismatch.academicYear ?? mismatch.academic_year ?? "")} / ${String(mismatch.semester ?? "")} is not assigned to your lecturer account.`), { statusCode: 403 });
}

async function preview(batchId: string) {
  const supabase = getSupabase();
  const [batchResult, rowsResult] = await Promise.all([
    supabase.from("result_import_batches").select("*").eq("id", batchId).single(),
    supabase.from("result_import_rows").select("*").eq("batch_id", batchId).order("row_number").limit(MAX_ROWS),
  ]);
  if (batchResult.error) throw batchResult.error;
  if (rowsResult.error) throw rowsResult.error;
  return { batch: batchResult.data, rows: rowsResult.data ?? [] };
}

router.post("/validate", requirePermission("results.import"), async (req: Request, res: Response, next: NextFunction) => {
  const supabase = getSupabase();
  let batchId: string | null = null;
  try {
    const sourceRows = Array.isArray(req.body?.rows) ? req.body.rows as ImportRow[] : [];
    if (!sourceRows.length) {
      res.status(400).json({ success: false, message: "The import file contains no result rows." });
      return;
    }
    if (sourceRows.length > MAX_ROWS) {
      res.status(400).json({ success: false, message: `A single import is limited to ${MAX_ROWS} rows.` });
      return;
    }
    await assertLecturerImportScope(req, sourceRows as Array<Record<string, unknown>>);

    const { data: batch, error: batchError } = await supabase.from("result_import_batches").insert({
      file_name: clean(req.body?.fileName, 255) ?? "results-import.csv",
      status: "UPLOADED", total_rows: sourceRows.length, created_by: actor(req),
    }).select("*").single();
    if (batchError || !batch) throw batchError ?? new Error("Could not create result import batch.");
    batchId = String(batch.id);

    const staged = sourceRows.map((row, index) => ({
      batch_id: batchId, row_number: index + 2,
      regno: clean(row.regno, 80), academic_year: clean(row.academicYear, 30),
      semester: clean(row.semester, 50), course_code: clean(row.courseCode, 50),
      coursework_mark: mark(row.coursework), examination_mark: mark(row.examination),
      result_type: (clean(row.resultType, 30) ?? "NORMAL").toUpperCase(), remarks: clean(row.remarks, 2000),
    }));
    const { error: rowsError } = await supabase.from("result_import_rows").insert(staged);
    if (rowsError) throw rowsError;
    const { error: validationError } = await supabase.rpc("validate_result_import_batch", { p_batch_id: batchId });
    if (validationError) throw validationError;

    const data = await preview(batchId);
    await createAuditLog({
      actorUserId: actor(req), actionCode: "RESULT_IMPORT_VALIDATE", moduleCode: "RESULTS",
      entityType: "result_import_batches", entityId: batchId,
      newValues: { fileName: data.batch.file_name, totalRows: data.batch.total_rows, validRows: data.batch.valid_rows, invalidRows: data.batch.invalid_rows },
      ipAddress: req.ip, requestId: req.requestId ?? null,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    if (batchId) {
      await supabase.from("result_import_batches").update({
        status: "FAILED", failure_message: error instanceof Error ? error.message : "Validation failed",
      }).eq("id", batchId);
    }
    next(error);
  }
});

router.get("/:id", requirePermission("results.view"), async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await preview(String(req.params.id)) }); }
  catch (error) { next(error); }
});

router.post("/:id/confirm", requirePermission("results.import"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchId = String(req.params.id);
    const supabase = getSupabase();
    const source = await supabase.from("result_import_rows").select("course_code,academic_year,semester").eq("batch_id", batchId).limit(MAX_ROWS);
    if (source.error) throw source.error;
    await assertLecturerImportScope(req, (source.data ?? []).map(row => ({ course_code: row.course_code, academic_year: row.academic_year, semester: row.semester })));
    const { error } = await supabase.rpc("confirm_result_import_batch", { p_batch_id: batchId, p_actor_id: actor(req) });
    if (error) throw error;
    const data = await preview(batchId);
    await createAuditLog({
      actorUserId: actor(req), actionCode: "RESULT_IMPORT_CONFIRM", moduleCode: "RESULTS",
      entityType: "result_import_batches", entityId: batchId,
      newValues: { importedRows: data.batch.valid_rows, invalidRows: data.batch.invalid_rows },
      ipAddress: req.ip, requestId: req.requestId ?? null,
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

export default router;
