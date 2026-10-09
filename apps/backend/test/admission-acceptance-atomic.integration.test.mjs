import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../../../", import.meta.url);
const migration = await readFile(new URL("../../../supabase/migrations/20261007280000_admission_acceptance_atomic.sql", import.meta.url), "utf8");

const fixture = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.applications(id uuid PRIMARY KEY, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.admission_offers(id uuid PRIMARY KEY, application_id uuid NOT NULL REFERENCES public.applications(id), offer_status text NOT NULL, expiry_date date, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.admission_acceptances(
 id uuid PRIMARY KEY, admission_offer_id uuid NOT NULL UNIQUE REFERENCES public.admission_offers(id),
 acceptance_status text NOT NULL DEFAULT 'PENDING', accepted_at timestamptz, declined_at timestamptz,
 decline_reason text, acceptance_ip_address inet, acceptance_user_agent text,
 accepted_by uuid REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES public.users(id), action_code text NOT NULL,
 module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb,
 ip_address inet, user_agent text, request_id varchar(100), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.sync_acceptance_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.admission_offers SET offer_status = CASE WHEN NEW.acceptance_status='ACCEPTED' THEN 'ACCEPTED' ELSE 'CANCELLED' END WHERE id=NEW.admission_offer_id;
 UPDATE public.applications SET status = CASE WHEN NEW.acceptance_status='ACCEPTED' THEN 'ACCEPTED' ELSE 'REJECTED' END WHERE id=(SELECT application_id FROM public.admission_offers WHERE id=NEW.admission_offer_id);
 RETURN NEW;
END $$;
CREATE TRIGGER fixture_acceptance_sync AFTER UPDATE OF acceptance_status ON public.admission_acceptances FOR EACH ROW EXECUTE FUNCTION public.sync_acceptance_fixture();
INSERT INTO users(id) VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO applications(id,status) VALUES ('22222222-2222-4222-8222-222222222222','ADMISSION_OFFERED');
INSERT INTO admission_offers(id,application_id,offer_status,expiry_date) VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','ISSUED',CURRENT_DATE+7);
INSERT INTO admission_acceptances(id,admission_offer_id) VALUES ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333');
`;

async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(migration);
  return db;
}

test("admission acceptance, trigger-synchronized offer/application and audit commit atomically", async () => {
  const db = await database();
  try {
    const result = await db.query(`SELECT (public.transition_admission_acceptance_atomic(
      '44444444-4444-4444-8444-444444444444','ACCEPTED','11111111-1111-4111-8111-111111111111',NULL,'127.0.0.1','agent','request-1')).acceptance_status`);
    assert.equal(result.rows[0].acceptance_status, "ACCEPTED");
    const state = await db.query(`
      SELECT a.acceptance_status, o.offer_status, p.status, count(l.id)::int AS audits
        FROM admission_acceptances a
        JOIN admission_offers o ON o.id=a.admission_offer_id
        JOIN applications p ON p.id=o.application_id
        LEFT JOIN audit_logs l ON l.entity_id=a.id
       GROUP BY a.id,o.id,p.id`);
    assert.deepEqual(state.rows[0], { acceptance_status: "ACCEPTED", offer_status: "ACCEPTED", status: "ACCEPTED", audits: 1 });
    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.transition_admission_acceptance_atomic(uuid,text,uuid,text,inet,text,character varying)','EXECUTE') AS anon_exec,
      has_function_privilege('authenticated','public.transition_admission_acceptance_atomic(uuid,text,uuid,text,inet,text,character varying)','EXECUTE') AS authenticated_exec,
      has_function_privilege('service_role','public.transition_admission_acceptance_atomic(uuid,text,uuid,text,inet,text,character varying)','EXECUTE') AS service_exec`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true });
  } finally { await db.close(); }
});

test("audit insertion failure rolls acceptance, offer and application back together", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE FUNCTION public.fail_acceptance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER fail_acceptance_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_acceptance_audit();`);
    await assert.rejects(() => db.query(`SELECT public.transition_admission_acceptance_atomic(
      '44444444-4444-4444-8444-444444444444','ACCEPTED','11111111-1111-4111-8111-111111111111',NULL,'127.0.0.1','agent','request-2')`), /audit unavailable/);
    const state = await db.query(`SELECT a.acceptance_status,o.offer_status,p.status
      FROM admission_acceptances a JOIN admission_offers o ON o.id=a.admission_offer_id
      JOIN applications p ON p.id=o.application_id WHERE a.id='44444444-4444-4444-8444-444444444444'`);
    assert.deepEqual(state.rows[0], { acceptance_status: "PENDING", offer_status: "ISSUED", status: "ADMISSION_OFFERED" });
    const audits = await db.query("SELECT count(*)::int AS count FROM audit_logs");
    assert.equal(audits.rows[0].count, 0);
  } finally { await db.close(); }
});
