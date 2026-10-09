import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../supabase/migrations/20261007290000_student_registration_approval_atomic.sql", import.meta.url), "utf8");
const fixture = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.student_registrations(id uuid PRIMARY KEY, registration_status text NOT NULL, academic_eligibility_status text NOT NULL, finance_eligibility_status text NOT NULL, document_eligibility_status text NOT NULL, approved_by uuid REFERENCES users(id), approved_at timestamptz, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.registration_approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_registration_id uuid NOT NULL REFERENCES student_registrations(id), approval_level integer NOT NULL, approval_role varchar(80) NOT NULL, approval_status text NOT NULL, comments text, approved_by uuid REFERENCES users(id), approved_at timestamptz, rejected_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(student_registration_id,approval_level));
CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), action_code text NOT NULL, module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id varchar(100), created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO student_registrations(id,registration_status,academic_eligibility_status,finance_eligibility_status,document_eligibility_status) VALUES ('22222222-2222-4222-8222-222222222222','SUBMITTED','ELIGIBLE','CLEARED','CLEARED');`;
async function database() { const db = new PGlite(); await db.exec(fixture); await db.exec(migration); return db; }

test("registration status, approval record and audit commit atomically", async () => {
  const db = await database();
  try {
    const result = await db.query(`SELECT public.approve_student_registration_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',1,'ACADEMIC','checked','127.0.0.1','registration-test') AS data`);
    assert.equal(result.rows[0].data.registration.registration_status, "APPROVED");
    assert.equal(result.rows[0].data.approval.approval_status, "APPROVED");
    const counts = await db.query("SELECT (SELECT count(*) FROM registration_approvals)::int AS approvals,(SELECT count(*) FROM audit_logs)::int AS audits");
    assert.deepEqual(counts.rows[0], { approvals: 1, audits: 1 });
    const grants = await db.query(`SELECT has_function_privilege('anon','public.approve_student_registration_atomic(uuid,uuid,integer,character varying,text,inet,character varying)','EXECUTE') AS anon_exec, has_function_privilege('authenticated','public.approve_student_registration_atomic(uuid,uuid,integer,character varying,text,inet,character varying)','EXECUTE') AS auth_exec, has_function_privilege('service_role','public.approve_student_registration_atomic(uuid,uuid,integer,character varying,text,inet,character varying)','EXECUTE') AS service_exec`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, auth_exec: false, service_exec: true });
  } finally { await db.close(); }
});

test("audit failure rolls the registration and approval history back", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE FUNCTION public.fail_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_registration_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_registration_audit();`);
    await assert.rejects(() => db.query(`SELECT public.approve_student_registration_atomic('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',1,'ACADEMIC',NULL,'127.0.0.1','registration-failure')`), /audit unavailable/);
    const state = await db.query("SELECT registration_status FROM student_registrations WHERE id='22222222-2222-4222-8222-222222222222'");
    assert.equal(state.rows[0].registration_status, "SUBMITTED");
    const counts = await db.query("SELECT (SELECT count(*) FROM registration_approvals)::int AS approvals,(SELECT count(*) FROM audit_logs)::int AS audits");
    assert.deepEqual(counts.rows[0], { approvals: 0, audits: 0 });
  } finally { await db.close(); }
});
