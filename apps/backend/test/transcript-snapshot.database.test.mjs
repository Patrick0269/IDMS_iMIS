import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationPaths = ["../../../supabase/migrations/20261007250000_transcript_snapshot_atomic.sql", "../../../supabase/migrations/20261007260000_transcript_lifecycle_atomic.sql"];
const migrations = await Promise.all(migrationPaths.map(path => readFile(new URL(path, import.meta.url), "utf8")));

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE students(id uuid PRIMARY KEY);
    CREATE TABLE academic_years(id uuid PRIMARY KEY, year_code text, start_date date);
    CREATE TABLE semesters(id uuid PRIMARY KEY, academic_year_id uuid, semester_code text, semester_number int);
    CREATE TABLE courses(id uuid PRIMARY KEY, course_code text, course_name text);
    CREATE TABLE course_offerings(id uuid PRIMARY KEY, course_id uuid);
    CREATE TABLE student_semester_results(
      id uuid PRIMARY KEY, student_id uuid, academic_year_id uuid, semester_id uuid,
      gpa numeric, total_registered_credits numeric, total_attempted_credits numeric,
      total_earned_credits numeric, total_quality_points numeric, academic_standing text,
      result_status text
    );
    CREATE TABLE course_results(
      id uuid PRIMARY KEY, student_id uuid, academic_year_id uuid, semester_id uuid,
      course_offering_id uuid, course_registration_id uuid, credits numeric,
      coursework_mark numeric, examination_mark numeric, total_mark numeric,
      grade_code text, grade_point numeric, result_type text, attempt_number int,
      pass_status text, result_status text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE student_transcripts(
      id uuid PRIMARY KEY, transcript_number text NOT NULL UNIQUE, student_id uuid NOT NULL,
      programme_version_id uuid, transcript_type text NOT NULL DEFAULT 'OFFICIAL', issue_reason text,
      cumulative_credits numeric NOT NULL DEFAULT 0, cumulative_earned_credits numeric NOT NULL DEFAULT 0,
      cumulative_quality_points numeric NOT NULL DEFAULT 0, cgpa numeric, final_academic_standing text,
      transcript_status text NOT NULL DEFAULT 'DRAFT', generated_at timestamptz, generated_by uuid,
      approved_at timestamptz, approved_by uuid, issued_at timestamptz, issued_by uuid,
      revoked_at timestamptz, revoked_by uuid, replacement_of uuid, document_file_id uuid,
      verification_code text UNIQUE, remarks text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE student_transcript_semesters(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transcript_id uuid, academic_year_id uuid,
      semester_id uuid, semester_result_id uuid, gpa numeric, registered_credits numeric,
      attempted_credits numeric, earned_credits numeric, quality_points numeric,
      academic_standing text, sequence_no int, UNIQUE(transcript_id,academic_year_id,semester_id),
      UNIQUE(transcript_id,sequence_no)
    );
    CREATE TABLE student_transcript_courses(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transcript_id uuid, transcript_semester_id uuid,
      course_result_id uuid, course_registration_id uuid, course_id uuid, course_code text, course_name text,
      credits numeric, coursework_mark numeric, examination_mark numeric, total_mark numeric,
      grade_code text, grade_point numeric, result_type text, attempt_number int, pass_status text,
      display_sequence int
    );
    CREATE TABLE audit_logs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text, module_code text,
      entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet,
      request_id varchar, created_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION block_transcript_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.transcript_status <> NEW.transcript_status AND NOT (
      (OLD.transcript_status='DRAFT' AND NEW.transcript_status='GENERATED') OR
      (OLD.transcript_status='GENERATED' AND NEW.transcript_status='REVIEW') OR
      (OLD.transcript_status='REVIEW' AND NEW.transcript_status='APPROVED') OR
      (OLD.transcript_status='APPROVED' AND NEW.transcript_status='ISSUED') OR
      (OLD.transcript_status='ISSUED' AND NEW.transcript_status='REVOKED')
    ) THEN RAISE EXCEPTION 'invalid transition'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER transcript_transition BEFORE UPDATE ON student_transcripts FOR EACH ROW EXECUTE FUNCTION block_transcript_transition();
  `);
  for (const migration of migrations) await db.exec(migration);
  return db;
}

const ids = {
  student: "11111111-1111-4111-8111-111111111111",
  year: "22222222-2222-4222-8222-222222222222",
  semester: "33333333-3333-4333-8333-333333333333",
  semesterResult: "44444444-4444-4444-8444-444444444444",
  course: "55555555-5555-4555-8555-555555555555",
  offering: "66666666-6666-4666-8666-666666666666",
  courseResult: "77777777-7777-4777-8777-777777777777",
  transcript: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
  reviewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  approver: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  issuer: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

async function insertFixture(db, includeResults = true) {
  await db.query("INSERT INTO users VALUES ($1),($2),($3),($4)", [ids.actor, ids.reviewer, ids.approver, ids.issuer]);
  await db.query("INSERT INTO students VALUES ($1)", [ids.student]);
  await db.query("INSERT INTO academic_years VALUES ($1,'AY26','2026-01-01')", [ids.year]);
  await db.query("INSERT INTO semesters VALUES ($1,$2,'S1',1)", [ids.semester, ids.year]);
  await db.query("INSERT INTO courses VALUES ($1,'CSC101','Computing')", [ids.course]);
  await db.query("INSERT INTO course_offerings VALUES ($1,$2)", [ids.offering, ids.course]);
  await db.query("INSERT INTO student_transcripts(id,transcript_number,student_id,verification_code) VALUES ($1,'IDMC/TR/2026/000001',$2,'VERIFY-1')", [ids.transcript, ids.student]);
  if (includeResults) {
    await db.query(`INSERT INTO student_semester_results VALUES ($1,$2,$3,$4,3.4,20,20,18,61.2,'GOOD','APPROVED')`, [ids.semesterResult, ids.student, ids.year, ids.semester]);
    await db.query(`INSERT INTO course_results(id,student_id,academic_year_id,semester_id,course_offering_id,credits,total_mark,grade_code,grade_point,result_type,attempt_number,pass_status,result_status)
      VALUES ($1,$2,$3,$4,$5,20,72,'B',3.5,'NORMAL',1,'PASS','PUBLISHED')`, [ids.courseResult, ids.student, ids.year, ids.semester, ids.offering]);
  }
}

test("transcript snapshot RPC atomically derives approved semester/course lines and audits generation", async () => {
  const db = await createDatabase();
  try {
    await insertFixture(db);
    const { rows } = await db.query("SELECT public.generate_student_transcript_snapshot_atomic($1,$2,'127.0.0.1','req-transcript') AS result", [ids.transcript, ids.actor]);
    assert.equal(Number(rows[0].result.semester_count), 1);
    assert.equal(Number(rows[0].result.course_count), 1);
    const header = await db.query("SELECT transcript_status,cgpa,cumulative_credits,cumulative_earned_credits,generated_by FROM student_transcripts WHERE id=$1", [ids.transcript]);
    assert.deepEqual(header.rows[0], { transcript_status: "GENERATED", cgpa: "3.500", cumulative_credits: "20", cumulative_earned_credits: "18", generated_by: ids.actor });
    const lines = await db.query("SELECT course_code,course_name,pass_status FROM student_transcript_courses WHERE transcript_id=$1", [ids.transcript]);
    assert.deepEqual(lines.rows, [{ course_code: "CSC101", course_name: "Computing", pass_status: "PASS" }]);
    const audit = await db.query("SELECT action_code,request_id FROM audit_logs WHERE entity_id=$1", [ids.transcript]);
    assert.deepEqual(audit.rows, [{ action_code: "TRANSCRIPT_GENERATE", request_id: "req-transcript" }]);
    const grant = await db.query("SELECT has_function_privilege('anon','public.generate_student_transcript_snapshot_atomic(uuid,uuid,inet,character varying)','EXECUTE') AS anon_can, has_function_privilege('service_role','public.generate_student_transcript_snapshot_atomic(uuid,uuid,inet,character varying)','EXECUTE') AS service_can");
    assert.deepEqual(grant.rows[0], { anon_can: false, service_can: true });
  } finally { await db.close(); }
});

test("transcript lifecycle RPC serializes status changes and enforces independent approval and issue actors", async () => {
  const db = await createDatabase();
  try {
    await insertFixture(db);
    await db.query("SELECT public.generate_student_transcript_snapshot_atomic($1,$2,NULL,'generate')", [ids.transcript, ids.actor]);
    await db.query("SELECT public.transition_student_transcript_atomic($1,$2,'REVIEW',NULL,NULL,'review')", [ids.transcript, ids.reviewer]);
    await assert.rejects(() => db.query("SELECT public.transition_student_transcript_atomic($1,$2,'APPROVE',NULL,NULL,'self-approve')", [ids.transcript, ids.actor]), /cannot approve the same transcript/);
    await db.query("SELECT public.transition_student_transcript_atomic($1,$2,'APPROVE',NULL,NULL,'approve')", [ids.transcript, ids.approver]);
    await assert.rejects(() => db.query("SELECT public.transition_student_transcript_atomic($1,$2,'ISSUE',NULL,NULL,'same-issuer')", [ids.transcript, ids.approver]), /cannot issue the same transcript/);
    await db.query("SELECT public.transition_student_transcript_atomic($1,$2,'ISSUE',NULL,NULL,'issue')", [ids.transcript, ids.issuer]);
    await assert.rejects(() => db.query("SELECT public.transition_student_transcript_atomic($1,$2,'REVOKE','bad',NULL,'revoke')", [ids.transcript, ids.actor]), /revocation reason/);
    await db.query("SELECT public.transition_student_transcript_atomic($1,$2,'REVOKE','Incorrect student record',NULL,'revoke')", [ids.transcript, ids.actor]);
    const state = await db.query("SELECT transcript_status,generated_by,approved_by,issued_by,revoked_by,remarks FROM student_transcripts WHERE id=$1", [ids.transcript]);
    assert.deepEqual(state.rows[0], { transcript_status: "REVOKED", generated_by: ids.actor, approved_by: ids.approver, issued_by: ids.issuer, revoked_by: ids.actor, remarks: "Incorrect student record" });
    const audits = await db.query("SELECT action_code,request_id FROM audit_logs WHERE entity_id=$1 ORDER BY created_at,id", [ids.transcript]);
    assert.deepEqual(audits.rows.map(row => row.action_code).sort(), ["TRANSCRIPT_APPROVE", "TRANSCRIPT_GENERATE", "TRANSCRIPT_ISSUE", "TRANSCRIPT_REVIEW", "TRANSCRIPT_REVOKE"].sort());
    const grant = await db.query("SELECT has_function_privilege('anon','public.transition_student_transcript_atomic(uuid,uuid,text,text,inet,character varying)','EXECUTE') AS anon_can, has_function_privilege('service_role','public.transition_student_transcript_atomic(uuid,uuid,text,text,inet,character varying)','EXECUTE') AS service_can");
    assert.deepEqual(grant.rows[0], { anon_can: false, service_can: true });
  } finally { await db.close(); }
});

test("transcript snapshot failure rolls back header and all line changes", async () => {
  const db = await createDatabase();
  try {
    await insertFixture(db, false);
    await assert.rejects(() => db.query("SELECT public.generate_student_transcript_snapshot_atomic($1,$2,NULL,'req-empty')", [ids.transcript, ids.actor]), /no approved semester results/);
    const state = await db.query("SELECT transcript_status,generated_at FROM student_transcripts WHERE id=$1", [ids.transcript]);
    assert.deepEqual(state.rows[0], { transcript_status: "DRAFT", generated_at: null });
    const counts = await db.query("SELECT (SELECT count(*) FROM student_transcript_semesters) AS semesters,(SELECT count(*) FROM student_transcript_courses) AS courses,(SELECT count(*) FROM audit_logs) AS audits");
    assert.deepEqual(counts.rows[0], { semesters: 0, courses: 0, audits: 0 });
  } finally { await db.close(); }
});
