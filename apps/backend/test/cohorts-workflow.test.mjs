import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("cohort migration adds the required programme, intake, schedule, campus and capacity fields without dropping records", async () => {
  const sql = await read("supabase/migrations/20261007110000_cohort_management.sql");
  const foundation = await read("supabase/migrations/202609270002_historical_students_cohorts_foundation.sql");
  for (const column of ["programme_id", "programme_version_id", "intake_code", "intake_name", "start_date", "expected_completion_date", "study_mode", "campus_id", "max_capacity", "notes"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /DROP CONSTRAINT IF EXISTS student_cohorts_institution_id_entry_year_key/);
  assert.match(foundation, /UNIQUE \(institution_id, cohort_code\)/);
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
});

test("cohort assignment is authorized, capacity-checked under lock and audited", async () => {
  const route = await read("apps/backend/src/modules/cohorts/cohorts.routes.ts");
  const sql = await read("supabase/migrations/20261007110000_cohort_management.sql");
  const index = await read("apps/backend/src/routes/index.ts");
  assert.match(index, /router\.use\("\/cohorts", cohortsRoutes\)/);
  assert.match(route, /requirePermission\("cohorts\.manage"\)/);
  assert.match(route, /COHORT_STUDENTS_ASSIGNED/);
  assert.match(route, /COHORT_STUDENT_REMOVED/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /v_existing \+ v_additional > v_cohort\.max_capacity/);
  assert.match(sql, /institution_id = v_cohort\.institution_id/);
  assert.match(sql, /cohort_id = p_expected_current_cohort\s+AND institution_id = v_cohort\.institution_id/);
  assert.match(route, /\.eq\("institution_id", institutionId\)/);
  assert.match(route, /COHORT_STUDENT_REMOVED/);
  assert.match(sql, /GRANT EXECUTE .* TO service_role/);
});

test("cohort reference data only exposes programme versions belonging to the IDMS institution", async () => {
  const route = await read("apps/backend/src/modules/cohorts/cohorts.routes.ts");
  assert.match(route, /const programmeIds = \(programmes\.data \?\? \[\]\)\.map\(\(programme: DbRow\) => programme\.id\)/);
  assert.match(route, /from\("programme_versions"\)[\s\S]*?\.in\("programme_id", programmeIds\)/);
  assert.match(route, /const versions = programmeIds\.length[\s\S]*?: \{ data: \[\], error: null \}/);
});

test("cohort assignment rolls back if the final write changes fewer students than validated", async () => {
  const sql = await read("supabase/migrations/20261007130000_cohort_assignment_rowcount_guard.sql");
  assert.match(sql, /GET DIAGNOSTICS v_changed = ROW_COUNT;\s+IF v_changed <> cardinality\(p_student_ids\) THEN\s+RAISE EXCEPTION[\s\S]*?ERRCODE = '40001'/);
  assert.match(sql, /\$\$;\s*REVOKE ALL ON FUNCTION public\.assign_students_to_cohort\(uuid, uuid\[\], uuid\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.assign_students_to_cohort\(uuid, uuid\[\], uuid\) TO service_role/);
});

test("cohort assignment rejects inactive and archived students through the API and final database write", async () => {
  const route = await read("apps/backend/src/modules/cohorts/cohorts.routes.ts");
  const sql = await read("supabase/migrations/20261007160000_cohort_programme_integrity_guard.sql");
  assert.ok(route.includes('.is("archived_at", null).neq("student_status", "INACTIVE").in("id", studentIds)'));
  assert.match(sql, /AND archived_at IS NULL\s+AND student_status <> 'INACTIVE'/);
  assert.match(sql, /programme_id IS NULL OR programme_id = v_cohort\.programme_id/);
  assert.match(sql, /programme_version_id IS NULL OR programme_version_id = v_cohort\.programme_version_id/);
  assert.match(sql, /v_changed <> cardinality\(p_student_ids\)/);
  assert.match(sql, /\$\$;\s*REVOKE ALL ON FUNCTION public\.assign_students_to_cohort/);
});

test("cohort edits lock the row and enforce roster capacity and programme constraints atomically", async () => {
  const route = await read("apps/backend/src/modules/cohorts/cohorts.routes.ts");
  const sql = await read("supabase/migrations/20261007150000_cohort_edit_roster_guard.sql");
  assert.match(route, /rpc\("update_cohort_with_roster_guard"/);
  assert.match(sql, /WHERE id = p_cohort_id AND institution_id = p_institution_id\s+FOR UPDATE/);
  assert.match(sql, /v_roster_count > 0 AND \([\s\S]*?IS DISTINCT FROM v_programme_id/);
  assert.match(sql, /v_capacity IS NOT NULL AND v_roster_count > v_capacity/);
  assert.match(sql, /\$\$;\s+REVOKE ALL ON FUNCTION public\.update_cohort_with_roster_guard/);
});

test("cohort page exposes filters, lifecycle editing, roster assignment and CSV export", async () => {
  const html = await read("apps/frontend/cohorts.html");
  const script = await read("apps/frontend/assets/js/cohorts.js");
  assert.match(html, /Cohort Management/);
  for (const label of ["cohortCode", "cohortName", "programmeId", "academicYearId", "intakeCode", "admissionYear", "startDate", "expectedCompletionDate", "studyMode", "campusId", "maxCapacity", "status", "notes"]) {
    assert.match(html, new RegExp(`name="${label}"`));
  }
  assert.match(script, /\/cohorts\/export\.csv/);
  assert.match(script, /available-students/);
  assert.match(script, /\/students/);
});

test("cohort assignment picker paginates and preserves a bounded cross-page selection", async () => {
  const html = await read("apps/frontend/cohorts.html");
  const script = await read("apps/frontend/assets/js/cohorts.js");
  assert.match(html, /candidatePreviousButton/);
  assert.match(html, /candidateNextButton/);
  assert.match(script, /candidatePage: 1, candidateTotal: 0, candidateLimit: 100/);
  assert.match(script, /selectedCandidates: new Set\(\)/);
  assert.match(script, /const studentIds = \[\.\.\.state\.selectedCandidates\]/);
  assert.match(script, /state\.selectedCandidates\.size >= 200/);
  assert.match(script, /candidatePage \* state\.candidateLimit >= state\.candidateTotal/);
});
