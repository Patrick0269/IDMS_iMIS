import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../../supabase/migrations/20261007190000_historical_academic_import_resume.sql", import.meta.url);
const route = new URL("../src/modules/historical-students/historical-academics.routes.ts", import.meta.url);
const pageScript = new URL("../../frontend/assets/js/historical-academics.js", import.meta.url);
const ids = {
  creator: "11111111-1111-4111-8111-111111111111",
  officer: "22222222-2222-4222-8222-222222222222",
  replacementOfficer: "33333333-3333-4333-8333-333333333333",
  batch: "44444444-4444-4444-8444-444444444444",
  firstRow: "55555555-5555-4555-8555-555555555555",
  secondRow: "66666666-6666-4666-8666-666666666666",
  stuckBatch: "77777777-7777-4777-8777-777777777777",
  stuckRow: "88888888-8888-4888-8888-888888888888",
  student: "99999999-9999-4999-8999-999999999999",
  skipBatch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  skipRow: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  year: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  semester: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  course: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.historical_academic_import_batches(
 id uuid PRIMARY KEY, batch_number text, status text, created_by uuid, confirmed_by uuid,
 confirmed_at timestamptz, imported_rows integer DEFAULT 0, skipped_rows integer DEFAULT 0,
 completed_at timestamptz, rolled_back_by uuid, rolled_back_at timestamptz, rollback_reason text,
 updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.historical_academic_import_rows(
 id uuid PRIMARY KEY, batch_id uuid, row_number integer, validation_status text,
 normalized_data jsonb, validation_errors jsonb DEFAULT '[]'::jsonb, course_attempt_id uuid,
 imported_at timestamptz, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.student_course_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, programme_version_id uuid,
 curriculum_id uuid, academic_year_id uuid, semester_id uuid, course_id uuid, import_row_id uuid,
 attempt_number integer, attempt_date date, coursework_mark numeric, examination_mark numeric,
 total_mark numeric, grade_code text, grade_point numeric, credits numeric, pass_status text,
 attempt_status text, result_type text, source_type text, recorded_by uuid, recorded_at timestamptz,
 locked_by uuid, locked_at timestamptz, remarks text, academic_import_batch_id uuid
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text, module_code text,
 entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet,
 request_id text, created_at timestamptz DEFAULT now()
);
`;

const normalized = { student_id: ids.student, academic_year_id: ids.year, semester_id: ids.semester,
  course_id: ids.course, attempt_number: 1, attempt_status: "LOCKED", result_type: "NORMAL",
  coursework_mark: 40, examination_mark: 50, total_mark: 90, grade_code: "A", grade_point: 4,
  credits: 3, pass_status: "PASS", remarks: "Imported record" };

test("academic batch confirmation resumes idempotently under a different officer", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_academic_import_batches(id,batch_number,status,created_by) VALUES ($1,'ACAD-1','READY',$2)", [ids.batch, ids.creator]);
    await db.query(`INSERT INTO historical_academic_import_rows(id,batch_id,row_number,validation_status,normalized_data)
      VALUES ($1,$3,1,'VALID',$4::jsonb),($2,$3,2,'VALID',$4::jsonb)`,
      [ids.firstRow, ids.secondRow, ids.batch, JSON.stringify(normalized)]);
    await db.exec(`CREATE FUNCTION fail_attempt_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test attempt failure'; END $$;
      CREATE TRIGGER fail_attempt_insert BEFORE INSERT ON student_course_attempts FOR EACH ROW EXECUTE FUNCTION fail_attempt_insert();`);

    await assert.rejects(
      db.query("SELECT public.start_or_resume_historical_academic_import($1,$2)", [ids.batch, ids.creator]),
      error => error.code === "42501",
    );
    await db.query("SELECT public.start_or_resume_historical_academic_import($1,$2)", [ids.batch, ids.officer]);
    await assert.rejects(
      db.query("SELECT public.import_historical_academic_attempt($1,$2,$3)", [ids.batch, ids.firstRow, ids.officer]),
      /test attempt failure/,
    );
    const failedAttemptState = await db.query(`SELECT r.validation_status,
      (SELECT count(*)::integer FROM student_course_attempts) AS attempt_count
      FROM historical_academic_import_rows r WHERE r.id=$1`, [ids.firstRow]);
    assert.equal(failedAttemptState.rows[0].validation_status, "VALID");
    assert.equal(failedAttemptState.rows[0].attempt_count, 0);
    await db.exec("DROP TRIGGER fail_attempt_insert ON student_course_attempts; DROP FUNCTION fail_attempt_insert();");
    const first = await db.query("SELECT public.import_historical_academic_attempt($1,$2,$3) AS result", [ids.batch, ids.firstRow, ids.officer]);
    assert.equal(first.rows[0].result.already_imported, false);
    const repeated = await db.query("SELECT public.import_historical_academic_attempt($1,$2,$3) AS result", [ids.batch, ids.firstRow, ids.officer]);
    assert.equal(repeated.rows[0].result.already_imported, true);
    assert.equal(repeated.rows[0].result.attempt_id, first.rows[0].result.attempt_id);

    await db.query("SELECT public.start_or_resume_historical_academic_import($1,$2)", [ids.batch, ids.replacementOfficer]);
    await assert.rejects(
      db.query("SELECT public.import_historical_academic_attempt($1,$2,$3)", [ids.batch, ids.secondRow, ids.officer]),
      error => error.code === "42501",
    );
    await db.query("SELECT public.import_historical_academic_attempt($1,$2,$3)", [ids.batch, ids.secondRow, ids.replacementOfficer]);
    await db.query("SELECT public.finish_historical_academic_import($1,$2)", [ids.batch, ids.replacementOfficer]);

    const final = await db.query(`SELECT b.status,b.imported_rows,count(DISTINCT a.id)::integer AS attempts,
      count(DISTINCT r.id)::integer AS imported_rows,count(DISTINCT audit.id)::integer AS audit_rows
      FROM historical_academic_import_batches b
      JOIN historical_academic_import_rows r ON r.batch_id=b.id
      JOIN student_course_attempts a ON a.academic_import_batch_id=b.id
      LEFT JOIN audit_logs audit ON audit.entity_id=b.id
      WHERE b.id=$1 GROUP BY b.id`, [ids.batch]);
    assert.equal(final.rows[0].status, "COMPLETED");
    assert.equal(final.rows[0].imported_rows, 2);
    assert.equal(final.rows[0].attempts, 2);
    assert.equal(final.rows[0].audit_rows, 3);

    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.start_or_resume_historical_academic_import(uuid,uuid,text,inet)','EXECUTE') AS anon_start,
      has_function_privilege('anon','public.import_historical_academic_attempt(uuid,uuid,uuid)','EXECUTE') AS anon_import,
      has_function_privilege('service_role','public.finish_historical_academic_import(uuid,uuid,text,inet)','EXECUTE') AS service_finish`);
    assert.equal(grants.rows[0].anon_start, false);
    assert.equal(grants.rows[0].anon_import, false);
    assert.equal(grants.rows[0].service_finish, true);
  } finally {
    await db.close();
  }
});

test("academic import cannot finalize while a VALID row remains", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_academic_import_batches(id,batch_number,status,created_by,confirmed_by) VALUES ($1,'ACAD-STUCK','IMPORTING',$2,$3)", [ids.stuckBatch, ids.creator, ids.officer]);
    await db.query("INSERT INTO historical_academic_import_rows(id,batch_id,row_number,validation_status,normalized_data) VALUES ($1,$2,1,'VALID',$3::jsonb)", [ids.stuckRow, ids.stuckBatch, JSON.stringify(normalized)]);
    await assert.rejects(
      db.query("SELECT public.finish_historical_academic_import($1,$2)", [ids.stuckBatch, ids.officer]),
      error => error.code === "55000",
    );
    const batch = await db.query("SELECT status FROM historical_academic_import_batches WHERE id=$1", [ids.stuckBatch]);
    assert.equal(batch.rows[0].status, "IMPORTING");
  } finally {
    await db.close();
  }
});

test("only the current importing officer can mark a failed row skipped", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_academic_import_batches(id,batch_number,status,created_by) VALUES ($1,'ACAD-SKIP','READY',$2)", [ids.skipBatch, ids.creator]);
    await db.query("INSERT INTO historical_academic_import_rows(id,batch_id,row_number,validation_status,normalized_data) VALUES ($1,$2,1,'VALID',$3::jsonb)", [ids.skipRow, ids.skipBatch, JSON.stringify(normalized)]);
    await db.query("SELECT public.start_or_resume_historical_academic_import($1,$2)", [ids.skipBatch, ids.officer]);
    await db.query("SELECT public.start_or_resume_historical_academic_import($1,$2)", [ids.skipBatch, ids.replacementOfficer]);

    await assert.rejects(
      db.query("SELECT public.skip_historical_academic_import_row($1,$2,$3,'foreign failure')", [ids.skipBatch, ids.skipRow, ids.officer]),
      error => error.code === "42501",
    );
    let row = await db.query("SELECT validation_status FROM historical_academic_import_rows WHERE id=$1", [ids.skipRow]);
    assert.equal(row.rows[0].validation_status, "VALID");

    await db.query("SELECT public.skip_historical_academic_import_row($1,$2,$3,'constraint failure')", [ids.skipBatch, ids.skipRow, ids.replacementOfficer]);
    await db.query("SELECT public.finish_historical_academic_import($1,$2)", [ids.skipBatch, ids.replacementOfficer]);
    const state = await db.query(`SELECT b.status,r.validation_status,b.skipped_rows
      FROM historical_academic_import_batches b JOIN historical_academic_import_rows r ON r.batch_id=b.id
      WHERE b.id=$1`, [ids.skipBatch]);
    assert.equal(state.rows[0].status, "COMPLETED_WITH_ERRORS");
    assert.equal(state.rows[0].validation_status, "SKIPPED");
    assert.equal(state.rows[0].skipped_rows, 1);
  } finally {
    await db.close();
  }
});

test("academic import API and UI expose a safe resumable path", async () => {
  const [source, script] = await Promise.all([readFile(route, "utf8"), readFile(pageScript, "utf8")]);
  assert.match(source, /start_or_resume_historical_academic_import/);
  assert.match(source, /import_historical_academic_attempt/);
  assert.match(source, /skip_historical_academic_import_row/);
  assert.match(source, /finish_historical_academic_import/);
  assert.doesNotMatch(source, /from\("student_course_attempts"\)\.insert\(attemptPayload\)/);
  assert.doesNotMatch(source, /from\("historical_academic_import_rows"\)\s*\n\s*\.update\(\{ validation_status: "SKIPPED"/);
  assert.match(script, /Resume import/);
});
