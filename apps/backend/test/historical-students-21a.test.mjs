import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import express from "express";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("historical student migration is additive and preserves institutional records", () => {
  const sql = read("supabase/migrations/202609270002_historical_students_cohorts_foundation.sql");
  for (const table of ["student_cohorts", "historical_import_batches", "historical_import_rows", "student_course_attempts"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
  }
  assert.match(sql, /generate_series\(2023, 2026\)/);
  assert.match(sql, /NORMAL_ADMISSION','HISTORICAL_IMPORT','MANUAL_ENTRY/);
  assert.match(sql, /historical_students\.rollback/);
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
});

test("historical students remain separate from Admissions and require clean confirmation", () => {
  const route = read("apps/backend/src/modules/historical-students/historical-students.routes.ts");
  const index = read("apps/backend/src/routes/index.ts");
  assert.match(index, /router\.use\("\/historical-students", historicalStudentsRoutes\)/);
  assert.match(route, /batch\.status !== "READY"/);
  assert.match(route, /allExistingStudentNumbers/);
  assert.match(route, /MANUAL_ENTRY/);
  assert.match(route, /historical_students\.rollback/);
  assert.match(route, /rpc\("rollback_historical_student_import"/);
  assert.doesNotMatch(route, /from\("students"\)\.update\(\{student_status:"INACTIVE"/);
  assert.doesNotMatch(route, /admission_offers|applications|applicants/);
});

test("student activation writes the nullable student updater audit field", () => {
  const admissions = read("apps/backend/src/modules/admissions/admissions.routes.ts");
  const students = read("apps/backend/src/modules/student-management/students/students.routes.ts");
  assert.match(admissions, /from\("students"\)\.update\(\{ user_id: linkedUser\.id, student_status: "ACTIVE", updated_by: req\.user!\.id, updated_at: now \}\)/);
  assert.match(students, /from\("students"\)\.update\(\{ student_status: "ACTIVE", updated_at: now \}\)/);
  assert.doesNotMatch(students, /from\("students"\)\.update\([^;]*updated_by/s);
});

test("student updater migration preserves existing rows and adds a nullable users foreign key", async () => {
  const migration = read("supabase/migrations/202610130001_students_updated_by_audit.sql");
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE public.users(id uuid PRIMARY KEY); CREATE TABLE public.students(id uuid PRIMARY KEY, student_status text, updated_at timestamptz);");
    await db.exec("INSERT INTO public.users(id) VALUES ('11111111-1111-4111-8111-111111111111'); INSERT INTO public.students(id,student_status) VALUES ('22222222-2222-4222-8222-222222222222','PENDING_ACTIVATION');");
    await db.exec(migration);
    await db.exec(migration);
    const column = await db.query("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='updated_by'");
    assert.deepEqual(column.rows, [{ data_type: "uuid", is_nullable: "YES" }]);
    await db.query("UPDATE public.students SET updated_by=$1 WHERE id=$2", ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    await db.exec("DELETE FROM public.users WHERE id='11111111-1111-4111-8111-111111111111'");
    const row = await db.query("SELECT student_status,updated_by FROM public.students WHERE id='22222222-2222-4222-8222-222222222222'");
    assert.deepEqual(row.rows, [{ student_status: "PENDING_ACTIVATION", updated_by: null }]);
  } finally {
    await db.close();
  }
});

test("historical account-link errors are explained in Kiswahili without raw database details", () => {
  const script = read("apps/frontend/assets/js/admissions-workspace.js");
  const errorHandler = read("apps/backend/src/middleware/errorHandler.ts");
  const admissions = read("apps/backend/src/modules/admissions/admissions.routes.ts");
  assert.match(script, /Muunganisho haujakamilika kwa sababu hifadhidata inahitaji kusasishwa/);
  assert.match(script, /muunganisho wa akaunti umeshindikana/i);
  assert.match(script, /Jaribu kuunganisha tena/);
  assert.match(script, /data-confirm-historical/);
  assert.match(script, /historicalError = historicalErrorMessage/);
  assert.match(script, /if \(state\.historicalError\)/);
  assert.match(errorHandler, /historical-students/);
  assert.match(errorHandler, /Muunganisho haujakamilika kwa sababu hifadhidata haijalinganishwa/);
  assert.match(admissions, /Mwanafunzi \$\{student\.student_number\} amethibitishwa/);
});

test("historical link schema errors return actionable Kiswahili without leaking database internals", async (t) => {
  const { errorHandler } = await import("../dist/middleware/errorHandler.js");
  const app = express();
  app.get("/api/v1/admissions/historical-students/:id/confirm", (_req, _res, next) => next({
    code: "42703",
    message: "Could not find the 'updated_by' column of 'students' in the schema cache",
  }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admissions/historical-students/test/confirm`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.message, /Msimamizi asakinishe sasisho la schema ya wanafunzi/);
  assert.doesNotMatch(body.message, /updated_by|schema cache/i);
});

test("CSV parser supports quoted data and rejects unsafe file types", async () => {
  const { parseSpreadsheet } = await import("../dist/modules/historical-students/spreadsheet.js");
  const csv = 'studentNumber,firstName,lastName,cohortYear\r\n"IDMC/2023/00001","Jane, Mary",Doe,2023\r\n';
  const rows = parseSpreadsheet("students.csv", Buffer.from(csv).toString("base64"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstName, "Jane, Mary");
  assert.throws(() => parseSpreadsheet("students.exe", Buffer.from("unsafe").toString("base64")), /Only \.csv and \.xlsx/);
});

test("historical student workspace exposes validate-preview-confirm and reconciliation", () => {
  const html = read("apps/frontend/historical-students.html");
  const script = read("apps/frontend/assets/js/historical-students.js");
  const dashboard = read("apps/frontend/assets/js/dashboard.js");
  for (const step of ["Upload", "Validate", "Preview", "Fix errors", "Confirm", "Report"]) assert.match(html, new RegExp(step));
  assert.match(script, /\/historical-students\/quality/);
  assert.match(script, /\/historical-students\/imports/);
  assert.match(dashboard, /historical-students\.html/);
});
