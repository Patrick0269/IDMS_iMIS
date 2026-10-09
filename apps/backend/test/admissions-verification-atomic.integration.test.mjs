import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../../../supabase/migrations/20261007210000_admissions_verification_atomic.sql', import.meta.url);
const route = new URL('../src/modules/admissions/admissions.routes.ts', import.meta.url);
const ids = {
  actor: '11111111-1111-4111-8111-111111111111',
  applicant: '22222222-2222-4222-8222-222222222222',
  application: '33333333-3333-4333-8333-333333333333',
  qualification1: '44444444-4444-4444-8444-444444444444',
  qualification2: '55555555-5555-4555-8555-555555555555',
  document1: '66666666-6666-4666-8666-666666666666',
  document2: '77777777-7777-4777-8777-777777777777'
};

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.applications(
 id uuid PRIMARY KEY, applicant_id uuid NOT NULL, status text NOT NULL,
 verification_status text NOT NULL, reviewed_by uuid, reviewed_at timestamptz,
 updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.academic_qualifications(
 id uuid PRIMARY KEY, applicant_id uuid NOT NULL, verification_status text NOT NULL,
 verified_by uuid, verified_at timestamptz, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.application_documents(
 id uuid PRIMARY KEY, application_id uuid NOT NULL, verification_status text NOT NULL,
 verified_by uuid, verified_at timestamptz, rejection_reason text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL,
 module_code text NOT NULL, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb,
 ip_address inet, request_id text, created_at timestamptz DEFAULT now()
);
`;

test('admissions verification commits qualifications, documents, application and audit atomically', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, 'utf8'));
    await db.query('INSERT INTO applications(id,applicant_id,status,verification_status) VALUES ($1,$2,$3,$4)', [ids.application, ids.applicant, 'CORRECTION_REQUIRED', 'REQUIRES_CORRECTION']);
    await db.query('INSERT INTO academic_qualifications(id,applicant_id,verification_status) VALUES ($1,$3,$4),($2,$3,$5)', [ids.qualification1, ids.qualification2, ids.applicant, 'PENDING', 'REQUIRES_REVIEW']);
    await db.query('INSERT INTO application_documents(id,application_id,verification_status,rejection_reason) VALUES ($1,$3,$4,$5),($2,$3,$6,$5)', [ids.document1, ids.document2, ids.application, 'PENDING', 'Missing page', 'REJECTED']);

    await db.exec(`CREATE FUNCTION fail_verification_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action_code='ADMISSIONS_VERIFY_ALL' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_verification_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_verification_audit();`);
    await assert.rejects(
      db.query('SELECT public.verify_application_records_atomic($1,$2,$3,$4::inet)', [ids.application, ids.actor, 'verify-fail', '192.0.2.7']),
      /forced audit failure/
    );
    let state = await db.query(`SELECT a.status,a.verification_status,
      (SELECT count(*) FROM academic_qualifications WHERE verification_status='VERIFIED') AS verified_qualifications,
      (SELECT count(*) FROM application_documents WHERE verification_status='VERIFIED') AS verified_documents,
      (SELECT count(*) FROM audit_logs) AS audits FROM applications a WHERE id=$1`, [ids.application]);
    assert.equal(state.rows[0].status, 'CORRECTION_REQUIRED');
    assert.equal(state.rows[0].verification_status, 'REQUIRES_CORRECTION');
    assert.equal(Number(state.rows[0].verified_qualifications), 0);
    assert.equal(Number(state.rows[0].verified_documents), 0);
    assert.equal(Number(state.rows[0].audits), 0);

    await db.exec('DROP TRIGGER fail_verification_audit ON audit_logs; DROP FUNCTION fail_verification_audit();');
    const result = await db.query('SELECT public.verify_application_records_atomic($1,$2,$3,$4::inet) AS result', [ids.application, ids.actor, 'verify-success', '192.0.2.7']);
    assert.equal(result.rows[0].result.status, 'VERIFIED');
    assert.equal(result.rows[0].result.qualifications_verified, 2);
    assert.equal(result.rows[0].result.documents_verified, 2);

    state = await db.query(`SELECT a.status,a.verification_status,
      (SELECT count(*) FROM academic_qualifications WHERE verification_status='VERIFIED' AND verified_by=$2) AS verified_qualifications,
      (SELECT count(*) FROM application_documents WHERE verification_status='VERIFIED' AND verified_by=$2 AND rejection_reason IS NULL) AS verified_documents,
      l.action_code,l.request_id,l.ip_address::text AS ip_address,l.old_values,l.new_values
      FROM applications a JOIN audit_logs l ON l.entity_id=a.id WHERE a.id=$1`, [ids.application, ids.actor]);
    assert.equal(state.rows[0].status, 'VERIFIED');
    assert.equal(state.rows[0].verification_status, 'VERIFIED');
    assert.equal(Number(state.rows[0].verified_qualifications), 2);
    assert.equal(Number(state.rows[0].verified_documents), 2);
    assert.equal(state.rows[0].action_code, 'ADMISSIONS_VERIFY_ALL');
    assert.equal(state.rows[0].request_id, 'verify-success');
    assert.equal(state.rows[0].ip_address, '192.0.2.7/32');
    assert.deepEqual(state.rows[0].old_values.qualification_states, { PENDING: 1, REQUIRES_REVIEW: 1 });
    assert.deepEqual(state.rows[0].old_values.document_states, { PENDING: 1, REJECTED: 1 });

    await db.query("UPDATE applications SET status='CONVERTED_TO_STUDENT' WHERE id=$1", [ids.application]);
    await assert.rejects(
      db.query('SELECT public.verify_application_records_atomic($1,$2)', [ids.application, ids.actor]),
      /cannot be verified/
    );
    const grants = await db.query(`SELECT has_function_privilege('service_role','public.verify_application_records_atomic(uuid,uuid,text,inet)','EXECUTE') AS service,
      has_function_privilege('authenticated','public.verify_application_records_atomic(uuid,uuid,text,inet)','EXECUTE') AS authenticated,
      has_function_privilege('anon','public.verify_application_records_atomic(uuid,uuid,text,inet)','EXECUTE') AS anon`);
    assert.equal(grants.rows[0].service, true);
    assert.equal(grants.rows[0].authenticated, false);
    assert.equal(grants.rows[0].anon, false);
  } finally {
    await db.close();
  }
});

test('Admissions VERIFY_ALL route delegates writes and audit to the atomic RPC', async () => {
  const source = await readFile(route, 'utf8');
  const verifyStart = source.indexOf('if (action === "VERIFY_ALL")');
  const verifyEnd = source.indexOf('if (action === "CONFIRM")', verifyStart);
  const verifyBlock = source.slice(verifyStart, verifyEnd);
  assert.notEqual(verifyStart, -1);
  assert.match(verifyBlock, /verify_application_records_atomic/);
  assert.doesNotMatch(verifyBlock, /\.from\("academic_qualifications"\)\.update|\.from\("application_documents"\)\.update|\.from\("applications"\)\.update/);
});
