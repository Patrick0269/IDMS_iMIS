import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../supabase/migrations/20261007300000_registration_finalization_atomic.sql", import.meta.url), "utf8");
const workflows = await readFile(new URL("../src/modules/workflows/workflow.routes.ts", import.meta.url), "utf8");
const fixture = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.students(id uuid PRIMARY KEY, student_status text NOT NULL, enrollment_date date, activated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.student_registrations(id uuid PRIMARY KEY, student_id uuid NOT NULL REFERENCES students(id), registration_status text NOT NULL, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), action_code text NOT NULL, module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id varchar(100), created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO students(id,student_status,enrollment_date) VALUES ('33333333-3333-4333-8333-333333333333','PENDING_ACTIVATION',NULL);
INSERT INTO student_registrations(id,student_id,registration_status) VALUES ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','APPROVED');`;

async function database() { const db = new PGlite(); await db.exec(fixture); await db.exec(migration); return db; }

test("final registration activates the student and writes audit atomically", async () => {
  const db = await database();
  try {
    const result = await db.query(`SELECT public.register_student_registration_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','127.0.0.1','register-test') AS data`);
    assert.equal(result.rows[0].data.registration.registration_status, "REGISTERED");
    assert.equal(result.rows[0].data.student.student_status, "ACTIVE");
    const counts = await db.query("SELECT (SELECT count(*) FROM audit_logs)::int AS audits, (SELECT count(*) FROM students WHERE student_status='ACTIVE')::int AS active_students");
    assert.deepEqual(counts.rows[0], { audits: 1, active_students: 1 });
    const grants = await db.query(`SELECT has_function_privilege('anon','public.register_student_registration_atomic(uuid,uuid,inet,character varying)','EXECUTE') AS anon_exec, has_function_privilege('authenticated','public.register_student_registration_atomic(uuid,uuid,inet,character varying)','EXECUTE') AS auth_exec, has_function_privilege('service_role','public.register_student_registration_atomic(uuid,uuid,inet,character varying)','EXECUTE') AS service_exec`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, auth_exec: false, service_exec: true });
    await db.query(`SELECT public.register_student_registration_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111')`);
    const repeat = await db.query("SELECT count(*)::int AS count FROM audit_logs");
    assert.equal(repeat.rows[0].count, 1);
  } finally { await db.close(); }
});

test("audit failure rolls registration and student activation back", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE FUNCTION public.fail_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_registration_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_registration_audit();`);
    await assert.rejects(() => db.query(`SELECT public.register_student_registration_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111')`), /audit unavailable/);
    const state = await db.query("SELECT r.registration_status,s.student_status,(SELECT count(*)::int FROM audit_logs) AS audits FROM student_registrations r JOIN students s ON s.id=r.student_id");
    assert.deepEqual(state.rows[0], { registration_status: "APPROVED", student_status: "PENDING_ACTIVATION", audits: 0 });
  } finally { await db.close(); }
});

test("registration endpoint delegates finalization to the atomic RPC", () => {
  const route = workflows.match(/router\.post\("\/registrations\/:id\/register"[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(route, /rpc\("register_student_registration_atomic"/);
  assert.doesNotMatch(route, /from\("(?:student_registrations|students)"\)\.update/);
});
