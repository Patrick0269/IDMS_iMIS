import { getSupabase } from "../../config/database.js";
type Row = Record<string, any>;
function reject(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
function positive(value: unknown, label: string, integer = false): number {
  const n = Number(value); if (value == null || value === "" || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) reject(`${label} must be a valid non-negative ${integer ? "whole number" : "number"}.`); return n;
}
export async function validateCourse(payload: Row, current: Row = {}): Promise<void> {
  const row = { ...current, ...payload };
  if (!String(row.course_code || "").trim() || !String(row.course_name || "").trim()) reject("Course code and name are required.");
  positive(row.credit_units, "Course credits");
  if (row.contact_hours != null) positive(row.contact_hours, "Contact hours");
  if (!row.department_id) reject("Assign the owning department. Sharing is configured separately through cross-cutting targets.");
  const department = await getSupabase().from("departments").select("id,institution_id,status").eq("id", row.department_id).maybeSingle();
  if (department.error) throw department.error;
  if (!department.data || department.data.institution_id !== row.institution_id || department.data.status !== "ACTIVE") reject("Select an active department from the same institution.");
}
export async function validateOffering(payload: Row, current: Row = {}): Promise<void> {
  const row = { ...current, ...payload }; const db = getSupabase();
  positive(row.capacity ?? 0, "Capacity", true); positive(row.minimum_students ?? 0, "Minimum students", true);
  if (Number(row.capacity) > 0 && Number(row.minimum_students) > Number(row.capacity)) reject("Minimum students cannot exceed a finite offering capacity.");
  if (!String(row.offering_code || "").trim() || String(row.offering_code).length > 80) reject("Offering code is required and must be no longer than 80 characters.");
  const opened = row.registration_open_at ? Date.parse(row.registration_open_at) : null;
  const closed = row.registration_close_at ? Date.parse(row.registration_close_at) : null;
  if ((opened !== null && !Number.isFinite(opened)) || (closed !== null && !Number.isFinite(closed))) reject("Enter valid registration dates.");
  if (opened !== null && closed !== null && closed < opened) reject("Registration closing time cannot be before opening time.");

  if (!row.programme_version_id) reject("Choose the active programme version for this offering.");
  const [semester, version, course] = await Promise.all([
    db.from("semesters").select("id,academic_year_id,semester_number").eq("id", row.semester_id).maybeSingle(),
    db.from("programme_versions").select("id,programme_id,status").eq("id", row.programme_version_id).maybeSingle(),
    db.from("courses").select("id,status").eq("id", row.course_id).maybeSingle(),
  ]);
  for (const result of [semester, version, course]) if (result.error) throw result.error;
  if (!semester.data || semester.data.academic_year_id !== row.academic_year_id) reject("Semester must belong to the selected academic year.");
  if (!version.data || version.data.programme_id !== row.programme_id || version.data.status !== "ACTIVE") reject("Choose an active version belonging to the selected programme.");
  if (!course.data || course.data.status !== "ACTIVE") reject("Choose an active Course Master record.");
  const curricula = await db.from("curricula").select("id").eq("programme_version_id", row.programme_version_id).eq("status", "ACTIVE");
  if (curricula.error) throw curricula.error;
  const ids = (curricula.data ?? []).map(x => x.id);
  const mapping = ids.length ? await db.from("curriculum_courses").select("id").in("curriculum_id", ids).eq("course_id", row.course_id).eq("semester_number", semester.data.semester_number).limit(1).maybeSingle() : { data: null, error: null };
  if (mapping.error) throw mapping.error;
  if (!mapping.data) reject("Map this course to the active curriculum and correct semester before creating an offering.");
  const duplicate = await db.from("course_offerings").select("id").eq("offering_code", row.offering_code).maybeSingle();
  if (duplicate.error) throw duplicate.error;
  if (duplicate.data && duplicate.data.id !== current.id) throw Object.assign(new Error("This offering code already exists. Refresh Course Offerings and edit the existing record, or use a distinct approved section code."), { statusCode: 409 });

}
