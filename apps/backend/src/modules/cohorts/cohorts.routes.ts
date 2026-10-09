import { Router, type Request } from "express";
import { z } from "zod";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";
import { escapeCsvCell } from "../../utils/csv.js";

const router = Router();
router.use(authenticate);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = ["ACTIVE", "INACTIVE", "CLOSED", "ARCHIVED"] as const;
const modes = ["FULL_TIME", "PART_TIME", "DISTANCE", "BLENDED", "EVENING", "OTHER"] as const;
const nullableUuid = z.union([z.string().regex(UUID), z.literal(""), z.null()]).optional();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");
const nullableDate = z.union([dateOnly, z.literal(""), z.null()]).optional();
const cohortSchema = z.object({
  cohortCode: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  cohortName: z.string().trim().min(2).max(120),
  programmeId: z.string().regex(UUID),
  programmeVersionId: nullableUuid,
  academicYearId: nullableUuid,
  intakeCode: z.string().trim().max(30).optional().default(""),
  intakeName: z.string().trim().max(80).optional().default(""),
  admissionYear: z.coerce.number().int().min(1900).max(2200),
  startDate: nullableDate,
  expectedCompletionDate: nullableDate,
  studyMode: z.enum(modes).default("FULL_TIME"),
  campusId: nullableUuid,
  maxCapacity: z.union([z.coerce.number().int().positive(), z.literal(""), z.null()]).optional(),
  status: z.enum(statuses).optional(),
  notes: z.string().trim().max(3000).optional().default(""),
});

type CohortPayload = z.infer<typeof cohortSchema>;
type DbRow = Record<string, any>;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function parseId(value: unknown, label = "Cohort") {
  if (typeof value !== "string" || !UUID.test(value)) throw httpError(`${label} ID is invalid.`, 400);
  return value;
}

function parsePayload(input: unknown): CohortPayload {
  const parsed = cohortSchema.safeParse(input);
  if (!parsed.success) throw httpError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400);
  const result = parsed.data;
  if (result.startDate && result.expectedCompletionDate && result.expectedCompletionDate < result.startDate) {
    throw httpError("Expected completion date must be on or after the cohort start date.", 400);
  }
  return result;
}

function dbPayload(value: CohortPayload, institutionId: string, actorId: string, creating: boolean): DbRow {
  const result: DbRow = {
    cohort_code: value.cohortCode.toUpperCase(),
    cohort_name: value.cohortName,
    institution_id: institutionId,
    programme_id: value.programmeId,
    programme_version_id: value.programmeVersionId || null,
    default_academic_year_id: value.academicYearId || null,
    intake_code: value.intakeCode?.toUpperCase() || null,
    intake_name: value.intakeName || null,
    entry_year: value.admissionYear,
    start_date: value.startDate || null,
    expected_completion_date: value.expectedCompletionDate || null,
    study_mode: value.studyMode,
    campus_id: value.campusId || null,
    max_capacity: value.maxCapacity === "" || value.maxCapacity == null ? null : value.maxCapacity,
    status: value.status || "ACTIVE",
    notes: value.notes || null,
    updated_by: actorId,
    updated_at: new Date().toISOString(),
  };
  if (creating) result.created_by = actorId;
  return result;
}

async function idmsInstitution() {
  const { data, error } = await getSupabase().from("institutions").select("id").eq("institution_code", "IDMS").maybeSingle();
  if (error) throw error;
  if (!data) throw httpError("The IDMS institution record is missing.", 503);
  return String(data.id);
}

async function validateReferences(value: CohortPayload, institutionId: string) {
  const db = getSupabase();
  const [programme, version, year, campus] = await Promise.all([
    db.from("programmes").select("id,status,institution_id").eq("id", value.programmeId).maybeSingle(),
    value.programmeVersionId ? db.from("programme_versions").select("id,programme_id").eq("id", value.programmeVersionId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    value.academicYearId ? db.from("academic_years").select("id,status").eq("id", value.academicYearId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    value.campusId ? db.from("campuses").select("id,status,institution_id").eq("id", value.campusId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const item of [programme, version, year, campus]) if (item.error) throw item.error;
  if (!programme.data || programme.data.institution_id !== institutionId || programme.data.status !== "ACTIVE") throw httpError("Select an active programme belonging to IDMS.", 400);
  if (value.programmeVersionId && (!version.data || version.data.programme_id !== value.programmeId)) throw httpError("The programme version does not belong to the selected programme.", 400);
  if (value.academicYearId && !year.data) throw httpError("The selected academic year was not found.", 400);
  if (value.campusId && (!campus.data || campus.data.institution_id !== institutionId || campus.data.status !== "ACTIVE")) throw httpError("Select an active IDMS campus.", 400);
}

function actor(req: Request) { return req.user?.id ?? null; }

router.get("/reference-data", requirePermission("cohorts.view"), async (_req, res, next) => {
  try {
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    const [programmes, years, campuses] = await Promise.all([
      db.from("programmes").select("id,programme_code,programme_name,status").eq("institution_id", institutionId).eq("status", "ACTIVE").order("programme_code"),
      db.from("academic_years").select("id,year_code,year_name,status,start_date,end_date").order("start_date", { ascending: false }),
      db.from("campuses").select("id,campus_code,campus_name,status").eq("institution_id", institutionId).eq("status", "ACTIVE").order("campus_name"),
    ]);
    for (const item of [programmes, years, campuses]) if (item.error) throw item.error;
    const programmeIds = (programmes.data ?? []).map((programme: DbRow) => programme.id);
    const versions = programmeIds.length
      ? await db.from("programme_versions").select("id,programme_id,version_code,version_name,status").in("programme_id", programmeIds).order("version_code")
      : { data: [], error: null };
    if (versions.error) throw versions.error;
    res.json({ success: true, data: { programmes: programmes.data ?? [], programmeVersions: versions.data ?? [], academicYears: years.data ?? [], campuses: campuses.data ?? [], studyModes: modes, statuses } });
  } catch (error) { next(error); }
});

router.get("/export.csv", requirePermission("cohorts.view"), async (req, res, next) => {
  try {
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    let query = db.from("student_cohorts").select("*", { count: "exact" }).eq("institution_id", institutionId).order("entry_year").order("cohort_code");
    if (req.query.programmeId && UUID.test(String(req.query.programmeId))) query = query.eq("programme_id", String(req.query.programmeId));
    if (req.query.academicYearId && UUID.test(String(req.query.academicYearId))) query = query.eq("default_academic_year_id", String(req.query.academicYearId));
    if (req.query.admissionYear && /^\d{4}$/.test(String(req.query.admissionYear))) query = query.eq("entry_year", Number(req.query.admissionYear));
    if (req.query.intakeCode) query = query.eq("intake_code", String(req.query.intakeCode).slice(0, 30));
    if (req.query.status && statuses.includes(String(req.query.status) as typeof statuses[number])) query = query.eq("status", String(req.query.status));
    const search = String(req.query.search ?? "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 80);
    if (search) query = query.or(`cohort_code.ilike.%${search}%,cohort_name.ilike.%${search}%`);
    const rows: DbRow[] = [];
    let totalRows = 0;
    for (let start = 0; start < 10000; start += 1000) {
      const { data, error, count } = await query.range(start, start + 999);
      if (error) throw error;
      totalRows = count ?? totalRows;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (totalRows > 10000) throw httpError("This export exceeds 10,000 cohorts. Narrow the filters and export again.", 413);
    const ids = rows.map(row => row.id);
    const programmeIds = [...new Set(rows.map(row => row.programme_id).filter(Boolean))];
    const versionIds = [...new Set(rows.map(row => row.programme_version_id).filter(Boolean))];
    const yearIds = [...new Set(rows.map(row => row.default_academic_year_id).filter(Boolean))];
    const campusIds = [...new Set(rows.map(row => row.campus_id).filter(Boolean))];
    const [programmes, versions, years, campuses] = await Promise.all([
      programmeIds.length ? db.from("programmes").select("id,programme_code,programme_name").in("id", programmeIds) : Promise.resolve({ data: [], error: null }),
      versionIds.length ? db.from("programme_versions").select("id,version_code,version_name").in("id", versionIds) : Promise.resolve({ data: [], error: null }),
      yearIds.length ? db.from("academic_years").select("id,year_code,year_name").in("id", yearIds) : Promise.resolve({ data: [], error: null }),
      campusIds.length ? db.from("campuses").select("id,campus_code,campus_name").in("id", campusIds) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const item of [programmes, versions, years, campuses]) if (item.error) throw item.error;
    const programById = new Map((programmes.data ?? []).map((row: DbRow) => [row.id, `${row.programme_code} · ${row.programme_name}`]));
    const versionById = new Map((versions.data ?? []).map((row: DbRow) => [row.id, `${row.version_code} · ${row.version_name ?? ""}`]));
    const yearById = new Map((years.data ?? []).map((row: DbRow) => [row.id, `${row.year_code} · ${row.year_name}`]));
    const campusById = new Map((campuses.data ?? []).map((row: DbRow) => [row.id, `${row.campus_code} · ${row.campus_name}`]));
    const rosterCounts = new Map<string, number>();
    if (ids.length) {
      const { data, error } = await db.rpc("get_cohort_student_counts", { p_cohort_ids: ids });
      if (error) throw error;
      for (const row of data ?? []) rosterCounts.set(row.cohort_id, Number(row.student_count));
    }
    const columns = ["cohort_code","cohort_name","programme","programme_version","entry_year","intake_code","intake_name","academic_year","start_date","expected_completion_date","study_mode","campus","max_capacity","status","student_count","notes"] as const;
    const body = [columns.join(","), ...rows.map(row => columns.map(key => escapeCsvCell(({ programme: programById.get(row.programme_id), programme_version: versionById.get(row.programme_version_id), academic_year: yearById.get(row.default_academic_year_id), campus: campusById.get(row.campus_id), student_count: rosterCounts.get(row.id) ?? 0 } as DbRow)[key] ?? row[key])).join(","))].join("\r\n");
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_EXPORT", moduleCode: "cohorts", entityType: "cohort_export", newValues: { count: rows.length }, requestId: req.requestId, ipAddress: req.ip });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="idmc-cohorts.csv"');
    res.send(`\uFEFF${body}`);
  } catch (error) { next(error); }
});

router.get("/", requirePermission("cohorts.view"), async (req, res, next) => {
  try {
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    let query = db.from("student_cohorts").select("*", { count: "exact" }).eq("institution_id", institutionId).order("entry_year", { ascending: false }).order("cohort_code").range((page - 1) * limit, page * limit - 1);
    const search = String(req.query.search ?? "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 80);
    if (search) query = query.or(`cohort_code.ilike.%${search}%,cohort_name.ilike.%${search}%`);
    if (req.query.programmeId && UUID.test(String(req.query.programmeId))) query = query.eq("programme_id", String(req.query.programmeId));
    if (req.query.admissionYear && /^\d{4}$/.test(String(req.query.admissionYear))) query = query.eq("entry_year", Number(req.query.admissionYear));
    if (req.query.academicYearId && UUID.test(String(req.query.academicYearId))) query = query.eq("default_academic_year_id", String(req.query.academicYearId));
    if (req.query.intakeCode) query = query.eq("intake_code", String(req.query.intakeCode).slice(0, 30));
    if (req.query.status && statuses.includes(String(req.query.status) as typeof statuses[number])) query = query.eq("status", String(req.query.status));
    const { data, error, count } = await query;
    if (error) throw error;
    const cohorts: DbRow[] = data ?? [];
    const ids = cohorts.map(row => row.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const { data: students, error: studentsError } = await db.rpc("get_cohort_student_counts", { p_cohort_ids: ids });
      if (studentsError) throw studentsError;
      for (const student of students ?? []) counts.set(student.cohort_id, Number(student.student_count));
    }
    res.json({ success: true, data: { rows: cohorts.map(row => ({ ...row, student_count: counts.get(row.id) ?? 0 })), page, limit, total: count ?? 0 } });
  } catch (error) { next(error); }
});

router.get("/:id/students", requirePermission("cohorts.view"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const institutionId = await idmsInstitution();
    const cohort = await getSupabase().from("student_cohorts").select("id").eq("id", id).eq("institution_id", institutionId).maybeSingle();
    if (cohort.error) throw cohort.error;
    if (!cohort.data) throw httpError("Cohort not found.", 404);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const { data, error, count } = await getSupabase().from("students").select("id,student_number,first_name,middle_name,last_name,email,student_status,programme_id,programme_version_id,cohort_id,admission_year", { count: "exact" }).eq("institution_id", institutionId).eq("cohort_id", id).is("archived_at", null).order("student_number").range((page - 1) * limit, page * limit - 1);
    if (error) throw error;
    res.json({ success: true, data: { rows: data ?? [], page, limit, total: count ?? 0 } });
  } catch (error) { next(error); }
});

router.get("/:id/available-students", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const cohortId = parseId(req.params.id);
    const institutionId = await idmsInstitution();
    const cohort = await getSupabase().from("student_cohorts").select("id").eq("id", cohortId).eq("institution_id", institutionId).maybeSingle();
    if (cohort.error) throw cohort.error;
    if (!cohort.data) throw httpError("Cohort not found.", 404);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const search = String(req.query.search ?? "").replace(/[^A-Za-z0-9 _./-]/g, "").trim().slice(0, 80);
    let query = getSupabase().from("students").select("id,student_number,first_name,middle_name,last_name,student_status,cohort_id", { count: "exact" }).eq("institution_id", institutionId).is("archived_at", null).neq("student_status", "INACTIVE").order("student_number").range((page - 1) * limit, page * limit - 1);
    if (search) query = query.or(`student_number.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ success: true, data: { rows: (data ?? []).map((row: DbRow) => ({ ...row, alreadyInThisCohort: row.cohort_id === cohortId })), page, limit, total: count ?? 0 } });
  } catch (error) { next(error); }
});

router.post("/:id/students", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const cohortId = parseId(req.params.id);
    const studentIds: string[] = Array.isArray(req.body?.studentIds) ? [...new Set<string>(req.body.studentIds.map((value: unknown) => String(value)))] : [];
    const reason = String(req.body?.reason ?? "").trim();
    if (!studentIds.length || studentIds.length > 200 || studentIds.some((id: string) => !UUID.test(id))) throw httpError("Select between 1 and 200 valid student records.", 400);
    if (reason.length < 5 || reason.length > 500) throw httpError("Enter a transfer/assignment reason (5–500 characters).", 400);
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    const cohort = await db.from("student_cohorts").select("id,cohort_code,status,programme_id,programme_version_id,entry_year").eq("id", cohortId).eq("institution_id", institutionId).maybeSingle();
    if (cohort.error) throw cohort.error;
    if (!cohort.data) throw httpError("Cohort not found.", 404);
    const cohortRow = cohort.data;
    const existing = await db.from("students").select("id,cohort_id,student_number,programme_id,programme_version_id,student_status").eq("institution_id", institutionId).is("archived_at", null).neq("student_status", "INACTIVE").in("id", studentIds);
    if (existing.error) throw existing.error;
    if ((existing.data ?? []).length !== studentIds.length) throw httpError("One or more students were not found.", 404);
    const incompatible = (existing.data ?? []).filter((row: DbRow) =>
      (row.programme_id && row.programme_id !== cohortRow.programme_id) ||
      (cohortRow.programme_version_id && row.programme_version_id && row.programme_version_id !== cohortRow.programme_version_id)
    );
    if (incompatible.length) throw httpError("Some selected students belong to a different programme/version. Complete an approved programme transfer before assigning them to this cohort.", 409);
    const { data: changed, error } = await db.rpc("assign_students_to_cohort", { p_cohort_id: cohortId, p_student_ids: studentIds, p_expected_current_cohort: null });
    if (error) throw error;
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_STUDENTS_ASSIGNED", moduleCode: "cohorts", entityType: "student_cohort", entityId: cohortId, oldValues: (existing.data ?? []).map((row: DbRow) => ({ student_id: row.id, cohort_id: row.cohort_id })), newValues: { student_ids: studentIds, reason }, requestId: req.requestId, ipAddress: req.ip });
    res.json({ success: true, data: { cohortId, updated: Number(changed), studentIds }, message: "Student cohort assignments were saved." });
  } catch (error) { next(error); }
});

router.delete("/:id/students/:studentId", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const cohortId = parseId(req.params.id);
    const studentId = parseId(req.params.studentId, "Student");
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 5 || reason.length > 500) throw httpError("Enter a removal reason (5–500 characters).", 400);
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    const cohort = await db.from("student_cohorts").select("id").eq("id", cohortId).eq("institution_id", institutionId).maybeSingle();
    if (cohort.error) throw cohort.error;
    if (!cohort.data) throw httpError("Cohort not found.", 404);
    const { data, error } = await db.rpc("assign_students_to_cohort", { p_cohort_id: null, p_student_ids: [studentId], p_expected_current_cohort: cohortId });
    if (error) throw error;
    if (!data) throw httpError("Student is not assigned to this cohort.", 409);
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_STUDENT_REMOVED", moduleCode: "cohorts", entityType: "student_cohort", entityId: cohortId, oldValues: { student_id: studentId, cohort_id: cohortId }, newValues: { cohort_id: null, reason }, requestId: req.requestId, ipAddress: req.ip });
    res.json({ success: true, data: { studentId, cohortId: null } });
  } catch (error) { next(error); }
});

router.post("/", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const value = parsePayload(req.body);
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    await validateReferences(value, institutionId);
    const { data, error } = await db.from("student_cohorts").insert(dbPayload(value, institutionId, actor(req)!, true)).select("*").single();
    if (error) { if (error.code === "23505") throw httpError("That cohort code already exists for IDMS.", 409); throw error; }
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_CREATED", moduleCode: "cohorts", entityType: "student_cohort", entityId: data.id, newValues: data, requestId: req.requestId, ipAddress: req.ip });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});

router.patch("/:id/status", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const status = String(req.body?.status ?? "").toUpperCase();
    if (!statuses.includes(status as typeof statuses[number])) throw httpError("Choose a valid cohort status.", 400);
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    const before = await db.from("student_cohorts").select("id,status").eq("id", id).eq("institution_id", institutionId).maybeSingle();
    if (before.error) throw before.error;
    if (!before.data) throw httpError("Cohort not found.", 404);
    const { data, error } = await db.from("student_cohorts").update({ status, updated_by: actor(req), updated_at: new Date().toISOString() }).eq("id", id).eq("institution_id", institutionId).select("*").single();
    if (error) throw error;
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_STATUS_CHANGED", moduleCode: "cohorts", entityType: "student_cohort", entityId: id, oldValues: before.data, newValues: { status }, requestId: req.requestId, ipAddress: req.ip });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/:id", requirePermission("cohorts.view"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const institutionId = await idmsInstitution();
    const { data, error } = await getSupabase().from("student_cohorts").select("*").eq("id", id).eq("institution_id", institutionId).maybeSingle();
    if (error) throw error;
    if (!data) throw httpError("Cohort not found.", 404);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.patch("/:id", requirePermission("cohorts.manage"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const value = parsePayload(req.body);
    const db = getSupabase();
    const institutionId = await idmsInstitution();
    await validateReferences(value, institutionId);
    const payload = dbPayload(value, institutionId, actor(req)!, false);
    const { data, error } = await db.rpc("update_cohort_with_roster_guard", { p_cohort_id: id, p_institution_id: institutionId, p_payload: payload, p_actor_id: actor(req) });
    if (error) {
      if (error.code === "23505") throw httpError("That cohort code already exists for IDMS.", 409);
      if (error.code === "P0002") throw httpError("Cohort not found.", 404);
      if (error.code === "23514") throw httpError(error.message, 409);
      throw error;
    }
    const result = data as { old_values: DbRow; new_values: DbRow };
    await createAuditLog({ actorUserId: actor(req), actionCode: "COHORT_UPDATED", moduleCode: "cohorts", entityType: "student_cohort", entityId: id, oldValues: result.old_values, newValues: result.new_values, requestId: req.requestId, ipAddress: req.ip });
    res.json({ success: true, data: result.new_values });
  } catch (error) { next(error); }
});

export default router;
