import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../../supabase/migrations/20261007180000_historical_academic_rollback_atomic.sql", import.meta.url);
const route = new URL("../src/modules/historical-students/historical-academics.routes.ts", import.meta.url);
const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  student: "22222222-2222-4222-8222-222222222222",
  batch: "33333333-3333-4333-8333-333333333333",
  row: "44444444-4444-4444-8444-444444444444",
  imported: "55555555-5555-4555-8555-555555555555",
  current: "66666666-6666-4666-8666-666666666666",
  year: "77777777-7777-4777-8777-777777777777",
  semester: "88888888-8888-4888-8888-888888888888",
  result: "99999999-9999-4999-8999-999999999999",
};

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.historical_academic_import_batches(
 id uuid PRIMARY KEY, status text NOT NULL, rolled_back_by uuid, rolled_back_at timestamptz,
 rollback_reason text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.students(id uuid PRIMARY KEY, programme_version_id uuid);
CREATE TABLE public.academic_years(id uuid PRIMARY KEY, start_date date);
CREATE TABLE public.semesters(id uuid PRIMARY KEY, academic_year_id uuid, semester_number integer, start_date date);
CREATE TABLE public.student_course_attempts(
 id uuid PRIMARY KEY, student_id uuid, academic_year_id uuid, semester_id uuid,
 credits numeric(10,2), grade_point numeric(5,2), pass_status text,
 attempt_status text, remarks text, updated_at timestamptz DEFAULT now(), academic_import_batch_id uuid
);
CREATE TABLE public.historical_academic_import_rows(
 id uuid PRIMARY KEY, batch_id uuid, validation_status text, course_attempt_id uuid, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.student_semester_results(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, academic_year_id uuid, semester_id uuid,
 programme_version_id uuid, total_registered_credits numeric(8,2) DEFAULT 0,
 total_attempted_credits numeric(8,2) DEFAULT 0, total_earned_credits numeric(8,2) DEFAULT 0,
 total_quality_points numeric(10,3) DEFAULT 0, gpa numeric(6,3), courses_attempted integer DEFAULT 0,
 courses_passed integer DEFAULT 0, courses_failed integer DEFAULT 0, academic_standing text,
 result_status text, calculated_at timestamptz, remarks text, updated_at timestamptz DEFAULT now(),
 UNIQUE(student_id,academic_year_id,semester_id)
);
CREATE TABLE public.student_gpa_records(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, academic_year_id uuid, semester_id uuid,
 semester_result_id uuid, gpa numeric(6,3) DEFAULT 0, total_credits numeric(8,2) DEFAULT 0,
 total_quality_points numeric(10,3) DEFAULT 0, calculation_version text DEFAULT '1.0',
 calculated_at timestamptz DEFAULT now(), UNIQUE(student_id,academic_year_id,semester_id)
);
CREATE TABLE public.student_cgpa_records(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, academic_year_id uuid, semester_id uuid,
 cumulative_credits numeric(10,2) DEFAULT 0, cumulative_earned_credits numeric(10,2) DEFAULT 0,
 cumulative_quality_points numeric(12,3) DEFAULT 0, cgpa numeric(6,3) DEFAULT 0,
 calculation_version text DEFAULT '1.0', calculated_at timestamptz DEFAULT now(),
 UNIQUE(student_id,academic_year_id,semester_id)
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL, module_code text NOT NULL,
 entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id text,
 created_at timestamptz DEFAULT now()
);
`;

test("academic import rollback atomically cancels attempts, recalculates GPA and writes audit", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_academic_import_batches(id,status) VALUES ($1,'COMPLETED')", [ids.batch]);
    await db.query("INSERT INTO students(id,programme_version_id) VALUES ($1,NULL)", [ids.student]);
    await db.query("INSERT INTO academic_years(id,start_date) VALUES ($1,'2025-01-01')", [ids.year]);
    await db.query("INSERT INTO semesters(id,academic_year_id,semester_number) VALUES ($1,$2,1)", [ids.semester, ids.year]);
    await db.query(`INSERT INTO student_course_attempts(id,student_id,academic_year_id,semester_id,credits,grade_point,pass_status,attempt_status,academic_import_batch_id)
      VALUES ($1,$2,$3,$4,6,4,'PASS','LOCKED',$5),($6,$2,$3,$4,3,3,'PASS','PUBLISHED',NULL)`,
      [ids.imported, ids.student, ids.year, ids.semester, ids.batch, ids.current]);
    await db.query("INSERT INTO historical_academic_import_rows(id,batch_id,validation_status,course_attempt_id) VALUES ($1,$2,'IMPORTED',$3)", [ids.row, ids.batch, ids.imported]);
    await db.query(`INSERT INTO student_semester_results(student_id,academic_year_id,semester_id,remarks,gpa)
      VALUES ($1,$2,$3,'Centralized calculation from historical course attempts',3)`, [ids.student, ids.year, ids.semester]);
    await db.exec(`CREATE FUNCTION fail_gpa_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test recalculation failure'; END $$;
      CREATE TRIGGER fail_gpa_insert BEFORE INSERT OR UPDATE ON student_gpa_records FOR EACH ROW EXECUTE FUNCTION fail_gpa_insert();`);

    await assert.rejects(
      db.query("SELECT public.rollback_historical_academic_import($1,$2,'Incorrect mark')", [ids.batch, ids.actor]),
      /test recalculation failure/,
    );
    let state = await db.query(`SELECT b.status, a.attempt_status, r.validation_status,
      sr.gpa, (SELECT count(*) FROM audit_logs) AS audit_count
      FROM historical_academic_import_batches b
      JOIN student_course_attempts a ON a.academic_import_batch_id=b.id
      JOIN historical_academic_import_rows r ON r.batch_id=b.id
      JOIN student_semester_results sr ON sr.student_id=a.student_id WHERE b.id=$1`, [ids.batch]);
    assert.equal(state.rows[0].status, "COMPLETED");
    assert.equal(state.rows[0].attempt_status, "LOCKED");
    assert.equal(state.rows[0].validation_status, "IMPORTED");
    assert.equal(Number(state.rows[0].gpa), 3);
    assert.equal(state.rows[0].audit_count, 0);

    await db.exec("DROP TRIGGER fail_gpa_insert ON student_gpa_records; DROP FUNCTION fail_gpa_insert();");
    const result = await db.query(
      "SELECT public.rollback_historical_academic_import($1,$2,$3,$4,$5::inet) AS batch",
      [ids.batch, ids.actor, "Incorrect mark", "academic-rollback-1", "192.0.2.9"],
    );
    assert.equal(result.rows[0].batch.status, "ROLLED_BACK");
    assert.equal(result.rows[0].batch.recalculated_students, 1);

    state = await db.query(`SELECT b.status, a.attempt_status, r.validation_status,
      sr.gpa, sr.total_attempted_credits, sr.total_earned_credits, g.gpa AS stored_gpa,
      cg.cgpa, audit.action_code, audit.request_id, audit.ip_address::text AS ip_address
      FROM historical_academic_import_batches b
      JOIN student_course_attempts a ON a.academic_import_batch_id=b.id
      JOIN historical_academic_import_rows r ON r.batch_id=b.id
      JOIN student_semester_results sr ON sr.student_id=a.student_id
      JOIN student_gpa_records g ON g.student_id=a.student_id
      JOIN student_cgpa_records cg ON cg.student_id=a.student_id
      JOIN audit_logs audit ON audit.entity_id=b.id WHERE b.id=$1`, [ids.batch]);
    assert.equal(state.rows[0].status, "ROLLED_BACK");
    assert.equal(state.rows[0].attempt_status, "CANCELLED");
    assert.equal(state.rows[0].validation_status, "ROLLED_BACK");
    assert.equal(Number(state.rows[0].gpa), 3);
    assert.equal(Number(state.rows[0].total_attempted_credits), 3);
    assert.equal(Number(state.rows[0].total_earned_credits), 3);
    assert.equal(Number(state.rows[0].stored_gpa), 3);
    assert.equal(Number(state.rows[0].cgpa), 3);
    assert.equal(state.rows[0].action_code, "HISTORICAL_ACADEMIC_ROLLBACK");
    assert.equal(state.rows[0].request_id, "academic-rollback-1");
    assert.equal(state.rows[0].ip_address, "192.0.2.9/32");

    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.rollback_historical_academic_import(uuid,uuid,text,text,inet)','EXECUTE') AS anon_call,
      has_function_privilege('service_role','public.rollback_historical_academic_import(uuid,uuid,text,text,inet)','EXECUTE') AS service_call`);
    assert.equal(grants.rows[0].anon_call, false);
    assert.equal(grants.rows[0].service_call, true);
  } finally {
    await db.close();
  }
});

test("academic rollback route delegates to the atomic database function", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /rpc\("rollback_historical_academic_import"/);
  assert.doesNotMatch(source, /from\("student_course_attempts"\)\.update\(\{attempt_status:"CANCELLED"/);
});
