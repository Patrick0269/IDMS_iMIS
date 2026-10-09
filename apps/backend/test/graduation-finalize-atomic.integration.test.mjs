import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../supabase/migrations/20261007320000_graduation_finalize_atomic.sql", import.meta.url), "utf8");
const route = await readFile(new URL("../src/modules/lifecycle-completion/lifecycle-completion.routes.ts", import.meta.url), "utf8");
const fixture = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.students(id uuid PRIMARY KEY, student_number text NOT NULL, student_status text NOT NULL, user_id uuid, email text, phone text, graduated_at timestamptz, actual_completion_date date, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.graduation_periods(id uuid PRIMARY KEY, graduation_date date NOT NULL);
CREATE TABLE public.programmes(id uuid PRIMARY KEY, programme_name text NOT NULL);
CREATE TABLE public.graduation_candidates(id uuid PRIMARY KEY, graduation_period_id uuid NOT NULL REFERENCES graduation_periods(id), student_id uuid NOT NULL REFERENCES students(id), programme_id uuid NOT NULL REFERENCES programmes(id), programme_version_id uuid, eligibility_status text NOT NULL, academic_completion_status text NOT NULL, candidate_status text NOT NULL, final_cgpa numeric(5,2), award_classification text, approved_by uuid, approved_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.graduation_clearances(graduation_candidate_id uuid NOT NULL REFERENCES graduation_candidates(id), clearance_type text NOT NULL, status text NOT NULL);
CREATE TABLE public.graduation_approvals(graduation_candidate_id uuid NOT NULL REFERENCES graduation_candidates(id), approval_stage text NOT NULL, decision text NOT NULL, approved_by uuid);
CREATE TABLE public.graduation_awards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), graduation_candidate_id uuid NOT NULL UNIQUE REFERENCES graduation_candidates(id), award_name text NOT NULL, award_classification text, final_cgpa numeric(5,2), graduation_date date NOT NULL, certificate_number text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.certificates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), graduation_award_id uuid NOT NULL REFERENCES graduation_awards(id), student_id uuid NOT NULL REFERENCES students(id), certificate_number text NOT NULL UNIQUE, award_name text NOT NULL, programme_id uuid, programme_version_id uuid, issue_date date, verification_code text NOT NULL UNIQUE, status text NOT NULL, issued_by uuid, issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.alumni_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL UNIQUE REFERENCES students(id), graduation_candidate_id uuid REFERENCES graduation_candidates(id), graduation_award_id uuid REFERENCES graduation_awards(id), alumni_number text NOT NULL UNIQUE, graduation_year integer NOT NULL, email text, phone text, status text NOT NULL);
CREATE TABLE public.student_lifecycle_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES students(id), event_type text NOT NULL, entity_type text, entity_id uuid, previous_state text, new_state text, actor_user_id uuid, event_data jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_number text NOT NULL UNIQUE, recipient_student_id uuid, recipient_user_id uuid, notification_type text NOT NULL, title text NOT NULL, body text NOT NULL, priority text NOT NULL, status text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL, module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id varchar(100));
INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO students(id,student_number,student_status,user_id,email,phone) VALUES ('33333333-3333-4333-8333-333333333333','IDMS/2020/00123456','ACTIVE','11111111-1111-4111-8111-111111111111','student@example.test','255700000000');
INSERT INTO graduation_periods VALUES ('44444444-4444-4444-8444-444444444444','2026-08-01');
INSERT INTO programmes VALUES ('55555555-5555-4555-8555-555555555555','Diploma in Development');
INSERT INTO graduation_candidates(id,graduation_period_id,student_id,programme_id,eligibility_status,academic_completion_status,candidate_status,final_cgpa,award_classification) VALUES ('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','ELIGIBLE','COMPLETE','APPROVED',4.2,'Upper Second');
INSERT INTO graduation_clearances SELECT '22222222-2222-4222-8222-222222222222',x,'CLEARED' FROM unnest(ARRAY['ACADEMIC','FINANCE','LIBRARY','HOSTEL','DEPARTMENT','EXAMINATION','DISCIPLINE','DOCUMENTS']) x;
INSERT INTO graduation_approvals SELECT '22222222-2222-4222-8222-222222222222',x,'APPROVED','11111111-1111-4111-8111-111111111111' FROM unnest(ARRAY['DEPARTMENT','HOD','ACADEMIC','EXAMINATION','REGISTRAR','MANAGEMENT']) x;`;

async function database() { const db = new PGlite(); await db.exec(fixture); await db.exec(migration); return db; }
const call = `SELECT public.finalize_graduation_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','AABBCCDDEEFF001122334455','123456','GRAD-TEST-000001','127.0.0.1','graduation-test') AS data`;

test("graduation, certificate, alumni, lifecycle event, notification and audit commit atomically", async () => {
  const db = await database();
  try {
    const result = await db.query(call);
    assert.equal(result.rows[0].data.candidate.candidate_status, "GRADUATED");
    assert.equal(result.rows[0].data.certificate.status, "ISSUED");
    assert.equal(result.rows[0].data.alumni.status, "ACTIVE");
    const counts = await db.query("SELECT (SELECT count(*)::int FROM graduation_awards) awards,(SELECT count(*)::int FROM certificates) certificates,(SELECT count(*)::int FROM alumni_records) alumni,(SELECT count(*)::int FROM student_lifecycle_events) events,(SELECT count(*)::int FROM notifications) notifications,(SELECT count(*)::int FROM audit_logs) audits");
    assert.deepEqual(counts.rows[0], { awards: 1, certificates: 1, alumni: 1, events: 1, notifications: 1, audits: 1 });
    const grants = await db.query(`SELECT has_function_privilege('anon','public.finalize_graduation_atomic(uuid,uuid,character varying,character varying,character varying,inet,character varying)','EXECUTE') AS anon_exec, has_function_privilege('authenticated','public.finalize_graduation_atomic(uuid,uuid,character varying,character varying,character varying,inet,character varying)','EXECUTE') AS auth_exec, has_function_privilege('service_role','public.finalize_graduation_atomic(uuid,uuid,character varying,character varying,character varying,inet,character varying)','EXECUTE') AS service_exec`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, auth_exec: false, service_exec: true });
  } finally { await db.close(); }
});

test("graduation audit failure rolls all lifecycle records back", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE FUNCTION public.fail_graduation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_graduation_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_graduation_audit();`);
    await assert.rejects(() => db.query(call), /audit unavailable/);
    const state = await db.query("SELECT c.candidate_status,s.student_status,(SELECT count(*)::int FROM graduation_awards) awards,(SELECT count(*)::int FROM certificates) certificates,(SELECT count(*)::int FROM alumni_records) alumni,(SELECT count(*)::int FROM student_lifecycle_events) events,(SELECT count(*)::int FROM notifications) notifications,(SELECT count(*)::int FROM audit_logs) audits FROM graduation_candidates c JOIN students s ON s.id=c.student_id");
    assert.deepEqual(state.rows[0], { candidate_status: "APPROVED", student_status: "ACTIVE", awards: 0, certificates: 0, alumni: 0, events: 0, notifications: 0, audits: 0 });
  } finally { await db.close(); }
});

test("graduation finalization is idempotent and requires every clearance and approval", async () => {
  const db = await database();
  try {
    await db.query(call);
    await db.query(call);
    const counts = await db.query("SELECT (SELECT count(*)::int FROM graduation_awards) awards,(SELECT count(*)::int FROM certificates) certificates,(SELECT count(*)::int FROM alumni_records) alumni,(SELECT count(*)::int FROM student_lifecycle_events) events,(SELECT count(*)::int FROM notifications) notifications,(SELECT count(*)::int FROM audit_logs) audits");
    assert.deepEqual(counts.rows[0], { awards: 1, certificates: 1, alumni: 1, events: 1, notifications: 1, audits: 1 });
    const blocked = await database();
    try {
      await blocked.exec("DELETE FROM graduation_clearances WHERE clearance_type='HOSTEL'");
      await assert.rejects(() => blocked.query("SELECT public.finalize_graduation_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','FFEEDDCCBBAA998877665544','654321','GRAD-TEST-000002')"), /All required graduation clearances/);
    } finally { await blocked.close(); }
  } finally { await db.close(); }
});

test("graduation finalization endpoint delegates the lifecycle writes to the RPC", () => {
  const handler = route.match(/router\.post\("\/candidates\/:id\/finalize"[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(handler, /rpc\("finalize_graduation_atomic"/);
  assert.doesNotMatch(handler, /\.from\("(?:graduation_candidates|graduation_awards|certificates|alumni_records|students|student_lifecycle_events|notifications)"\)\.(?:insert|update)/);
});
