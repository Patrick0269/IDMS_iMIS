import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../../../supabase/migrations/20261007220000_admission_offer_issue_atomic.sql', import.meta.url);
const route = new URL('../src/modules/admissions/admissions.routes.ts', import.meta.url);
const ids = {
  actor: '11111111-1111-4111-8111-111111111111',
  applicant: '22222222-2222-4222-8222-222222222222',
  application: '33333333-3333-4333-8333-333333333333',
  programme: '44444444-4444-4444-8444-444444444444',
  choice: '55555555-5555-4555-8555-555555555555',
  qualification: '66666666-6666-4666-8666-666666666666',
  document: '77777777-7777-4777-8777-777777777777'
};
const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.applications(
 id uuid PRIMARY KEY, applicant_id uuid NOT NULL, status text NOT NULL, verification_status text NOT NULL,
 eligibility_status text DEFAULT 'PENDING', selection_status text DEFAULT 'PENDING', reviewed_by uuid,
 reviewed_at timestamptz, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.applicants(id uuid PRIMARY KEY);
CREATE TABLE public.programmes(id uuid PRIMARY KEY);
CREATE TABLE public.application_choices(
 id uuid PRIMARY KEY, application_id uuid NOT NULL, programme_id uuid NOT NULL, choice_number integer NOT NULL,
 status text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.academic_qualifications(id uuid PRIMARY KEY, applicant_id uuid NOT NULL, verification_status text NOT NULL);
CREATE TABLE public.application_documents(id uuid PRIMARY KEY, application_id uuid NOT NULL, verification_status text NOT NULL);
CREATE TABLE public.admission_decisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL, application_choice_id uuid,
 decision_type text NOT NULL, decision_status text NOT NULL, decision_date timestamptz, decision_reason text,
 capacity_check boolean NOT NULL, academic_check boolean NOT NULL, document_check boolean NOT NULL,
 approved_by uuid, approved_at timestamptz, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.admission_offers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL, programme_id uuid NOT NULL,
 decision_id uuid, offer_number text NOT NULL UNIQUE, offer_date date NOT NULL, expiry_date date,
 offer_status text NOT NULL, admission_conditions text, issued_by uuid, issued_at timestamptz DEFAULT now()
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL, module_code text NOT NULL,
 entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id text,
 created_at timestamptz DEFAULT now()
);
`;

test('decision, offer, application state and audit are atomic and idempotent', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, 'utf8'));
    await db.query('INSERT INTO applicants(id) VALUES ($1)', [ids.applicant]);
    await db.query('INSERT INTO programmes(id) VALUES ($1)', [ids.programme]);
    await db.query("INSERT INTO applications(id,applicant_id,status,verification_status) VALUES ($1,$2,'VERIFIED','VERIFIED')", [ids.application, ids.applicant]);
    await db.query("INSERT INTO application_choices(id,application_id,programme_id,choice_number,status) VALUES ($1,$2,$3,1,'PENDING')", [ids.choice, ids.application, ids.programme]);
    await db.query("INSERT INTO academic_qualifications(id,applicant_id,verification_status) VALUES ($1,$2,'VERIFIED')", [ids.qualification, ids.applicant]);
    await db.query("INSERT INTO application_documents(id,application_id,verification_status) VALUES ($1,$2,'VERIFIED')", [ids.document, ids.application]);

    await db.query("UPDATE application_documents SET verification_status='REJECTED' WHERE id=$1", [ids.document]);
    await assert.rejects(
      db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4,$5,$6::inet,$7)', [ids.application, ids.actor, 'OFFER-BLOCKED', expiryDate, null, null, true]),
      /Verify all application documents/
    );
    await db.query("UPDATE application_documents SET verification_status='VERIFIED' WHERE id=$1", [ids.document]);
    await db.query("UPDATE academic_qualifications SET verification_status='PENDING' WHERE id=$1", [ids.qualification]);
    await assert.rejects(
      db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4,$5,$6::inet,$7)', [ids.application, ids.actor, 'OFFER-BLOCKED', expiryDate, null, null, true]),
      /Verify all applicant qualifications/
    );
    await db.query("UPDATE academic_qualifications SET verification_status='VERIFIED' WHERE id=$1", [ids.qualification]);

    await db.exec(`CREATE FUNCTION fail_offer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action_code LIKE 'ADMISSION_OFFER_%' THEN RAISE EXCEPTION 'forced offer audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_offer_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_offer_audit();`);
    await assert.rejects(
      db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4,$5,$6::inet,$7)', [ids.application, ids.actor, 'OFFER-TEST-1', expiryDate, 'offer-fail', '192.0.2.8', true]),
      /forced offer audit failure/
    );
    let state = await db.query(`SELECT a.status,
      (SELECT count(*) FROM admission_decisions) AS decisions,
      (SELECT count(*) FROM admission_offers) AS offers,
      (SELECT count(*) FROM audit_logs) AS audits FROM applications a WHERE a.id=$1`, [ids.application]);
    assert.equal(state.rows[0].status, 'VERIFIED');
    assert.equal(Number(state.rows[0].decisions), 0);
    assert.equal(Number(state.rows[0].offers), 0);
    assert.equal(Number(state.rows[0].audits), 0);

    await db.exec('DROP TRIGGER fail_offer_audit ON audit_logs; DROP FUNCTION fail_offer_audit();');
    let result = await db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4,$5,$6::inet,$7) AS result', [ids.application, ids.actor, 'OFFER-TEST-1', expiryDate, 'offer-success', '192.0.2.8', true]);
    assert.equal(result.rows[0].result.newly_issued, true);
    assert.equal(result.rows[0].result.offer.offer_status, 'ISSUED');

    result = await db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4,$5,$6::inet,$7) AS result', [ids.application, ids.actor, 'OFFER-TEST-2', expiryDate, 'offer-repeat', '192.0.2.9', true]);
    assert.equal(result.rows[0].result.newly_issued, false);
    assert.equal(result.rows[0].result.offer.offer_number, 'OFFER-TEST-1');
    state = await db.query(`SELECT a.status,a.eligibility_status,a.selection_status,c.status AS choice_status,
      (SELECT count(*) FROM admission_decisions WHERE decision_status='APPROVED') AS decisions,
      (SELECT count(*) FROM admission_offers WHERE offer_status='ISSUED') AS offers,
      (SELECT count(*) FROM audit_logs WHERE action_code='ADMISSION_OFFER_ISSUED') AS issued_audits,
      (SELECT count(*) FROM audit_logs WHERE action_code='ADMISSION_OFFER_REUSED') AS reuse_audits,
      (SELECT request_id FROM audit_logs WHERE action_code='ADMISSION_OFFER_ISSUED') AS request_id,
      (SELECT ip_address::text FROM audit_logs WHERE action_code='ADMISSION_OFFER_ISSUED') AS ip_address
      FROM applications a JOIN application_choices c ON c.application_id=a.id WHERE a.id=$1`, [ids.application]);
    assert.equal(state.rows[0].status, 'ADMISSION_OFFERED');
    assert.equal(state.rows[0].eligibility_status, 'ELIGIBLE');
    assert.equal(state.rows[0].selection_status, 'SELECTED');
    assert.equal(state.rows[0].choice_status, 'SELECTED');
    assert.equal(Number(state.rows[0].decisions), 1);
    assert.equal(Number(state.rows[0].offers), 1);
    assert.equal(Number(state.rows[0].issued_audits), 1);
    assert.equal(Number(state.rows[0].reuse_audits), 1);
    assert.equal(state.rows[0].request_id, 'offer-success');
    assert.equal(state.rows[0].ip_address, '192.0.2.8/32');

    await db.query("UPDATE applications SET status='REJECTED' WHERE id=$1", [ids.application]);
    await assert.rejects(
      db.query('SELECT public.issue_admission_offer_atomic($1,$2,$3,$4)', [ids.application, ids.actor, 'OFFER-TEST-3', expiryDate]),
      /can only be issued for a selected application/
    );
    const grants = await db.query(`SELECT has_function_privilege('service_role','public.issue_admission_offer_atomic(uuid,uuid,text,date,text,inet,boolean)','EXECUTE') AS service,
      has_function_privilege('authenticated','public.issue_admission_offer_atomic(uuid,uuid,text,date,text,inet,boolean)','EXECUTE') AS authenticated,
      has_function_privilege('anon','public.issue_admission_offer_atomic(uuid,uuid,text,date,text,inet,boolean)','EXECUTE') AS anon`);
    assert.equal(grants.rows[0].service, true);
    assert.equal(grants.rows[0].authenticated, false);
    assert.equal(grants.rows[0].anon, false);
  } finally {
    await db.close();
  }
});

test('offer-issuing API delegates all decision/offer writes and audit to the atomic RPC', async () => {
  const source = await readFile(route, 'utf8');
  const start = source.indexOf('async function issueAdmissionOffer(');
  const end = source.indexOf('\nasync function convertAcceptedApplication', start);
  const block = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(block, /issue_admission_offer_atomic/);
  assert.doesNotMatch(block, /\.from\("admission_decisions"\)\.(?:insert|update)|\.from\("admission_offers"\)\.(?:insert|update)|\.from\("applications"\)\.update/);
});
