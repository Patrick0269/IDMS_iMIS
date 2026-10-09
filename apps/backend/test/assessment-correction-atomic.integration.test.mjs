import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../supabase/migrations/20261007310000_assessment_mark_correction_atomic.sql", import.meta.url), "utf8");
const workflows = await readFile(new URL("../src/modules/workflows/workflow.routes.ts", import.meta.url), "utf8");
const fixture = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.assessments(id uuid PRIMARY KEY, status text NOT NULL, maximum_marks numeric(8,2) NOT NULL);
CREATE TABLE public.assessment_marks(id uuid PRIMARY KEY, assessment_id uuid NOT NULL REFERENCES assessments(id), student_id uuid NOT NULL, course_registration_id uuid, marks numeric(8,2) NOT NULL, percentage numeric(8,4), grade varchar(10), remarks text, status varchar(30) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.assessment_mark_corrections(id uuid PRIMARY KEY, assessment_mark_id uuid NOT NULL REFERENCES assessment_marks(id), requested_by uuid NOT NULL REFERENCES users(id), old_marks numeric(8,2), new_marks numeric(8,2), old_grade varchar(20), new_grade varchar(20), reason text NOT NULL, status varchar(30) NOT NULL DEFAULT 'PENDING', reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, review_comment text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), action_code text NOT NULL, module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id varchar(100), created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO assessments VALUES ('44444444-4444-4444-8444-444444444444','LOCKED',100);
INSERT INTO assessment_marks(id,assessment_id,student_id,marks,percentage,grade,status) VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',80,80,'B','LOCKED');
INSERT INTO assessment_mark_corrections(id,assessment_mark_id,requested_by,old_marks,new_marks,old_grade,new_grade,reason) VALUES ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',80,90,'B','A','Verified marking correction');`;

async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(migration);
  await db.exec(`CREATE TRIGGER fixture_locked_mark BEFORE UPDATE ON public.assessment_marks FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_assessment_mark_change()`);
  return db;
}

test("approved correction updates locked mark and audit atomically", async () => {
  const db = await database();
  try {
    const result = await db.query(`SELECT public.decide_assessment_mark_correction_atomic('22222222-2222-4222-8222-222222222222','APPROVED','11111111-1111-4111-8111-111111111111','reviewed','127.0.0.1','correction-test') AS data`);
    assert.equal(result.rows[0].data.correction.status, "APPROVED");
    assert.equal(result.rows[0].data.mark.marks, 90);
    assert.equal(result.rows[0].data.mark.percentage, 90);
    assert.equal(result.rows[0].data.mark.status, "CORRECTION_PENDING");
    const grants = await db.query(`SELECT has_function_privilege('anon','public.decide_assessment_mark_correction_atomic(uuid,text,uuid,text,inet,character varying)','EXECUTE') AS anon_exec, has_function_privilege('authenticated','public.decide_assessment_mark_correction_atomic(uuid,text,uuid,text,inet,character varying)','EXECUTE') AS auth_exec, has_function_privilege('service_role','public.decide_assessment_mark_correction_atomic(uuid,text,uuid,text,inet,character varying)','EXECUTE') AS service_exec`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, auth_exec: false, service_exec: true });
  } finally { await db.close(); }
});

test("audit failure rolls back correction decision and locked mark update", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE FUNCTION public.fail_correction_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_correction_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_correction_audit();`);
    await assert.rejects(() => db.query(`SELECT public.decide_assessment_mark_correction_atomic('22222222-2222-4222-8222-222222222222','APPROVED','11111111-1111-4111-8111-111111111111')`), /audit unavailable/);
    const state = await db.query("SELECT c.status AS correction_status,m.marks,m.status AS mark_status,(SELECT count(*)::int FROM audit_logs) AS audits FROM assessment_mark_corrections c JOIN assessment_marks m ON m.id=c.assessment_mark_id");
    assert.deepEqual(state.rows[0], { correction_status: "PENDING", marks: "80.00", mark_status: "LOCKED", audits: 0 });
  } finally { await db.close(); }
});

test("rejected corrections leave assessment marks unchanged", async () => {
  const db = await database();
  try {
    const result = await db.query(`SELECT public.decide_assessment_mark_correction_atomic('22222222-2222-4222-8222-222222222222','REJECTED','11111111-1111-4111-8111-111111111111') AS data`);
    assert.equal(result.rows[0].data.correction.status, "REJECTED");
    assert.equal(result.rows[0].data.mark.marks, 80);
    const audits = await db.query("SELECT count(*)::int AS count FROM audit_logs");
    assert.equal(audits.rows[0].count, 1);
  } finally { await db.close(); }
});

test("assessment correction endpoint delegates writes and audit to the atomic RPC", () => {
  const route = workflows.match(/router\.post\("\/assessment-corrections\/:id\/decide"[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(route, /rpc\("decide_assessment_mark_correction_atomic"/);
  assert.doesNotMatch(route, /from\("(?:assessment_mark_corrections|assessment_marks)"\)\.update/);
});
