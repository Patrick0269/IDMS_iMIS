import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../../supabase/migrations/20261007200000_historical_academic_batch_create_atomic.sql", import.meta.url);
const route = new URL("../src/modules/historical-students/historical-academics.routes.ts", import.meta.url);
const ids = {
  institution: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
};

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.institutions(id uuid PRIMARY KEY);
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.historical_academic_import_batches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_number varchar(70) UNIQUE NOT NULL,
 institution_id uuid NOT NULL REFERENCES institutions(id), source_format varchar(20) NOT NULL CHECK(source_format IN ('CSV','XLSX','MANUAL')),
 source_file_name varchar(255), source_file_sha256 varchar(64),
 status varchar(30) NOT NULL CHECK(status IN ('UPLOADED','VALIDATED','READY','IMPORTING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED','ROLLED_BACK')),
 total_rows integer NOT NULL, valid_rows integer NOT NULL, invalid_rows integer NOT NULL, duplicate_rows integer NOT NULL,
 imported_rows integer NOT NULL DEFAULT 0, skipped_rows integer NOT NULL DEFAULT 0,
 created_by uuid REFERENCES users(id), validated_at timestamptz,
 confirmed_by uuid REFERENCES users(id), confirmed_at timestamptz, completed_at timestamptz,
 rolled_back_by uuid REFERENCES users(id), rolled_back_at timestamptz, rollback_reason text,
 created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
 CHECK(confirmed_by IS NULL OR created_by IS NULL OR confirmed_by <> created_by)
);
CREATE TABLE public.historical_academic_import_rows(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES historical_academic_import_batches(id),
 row_number integer NOT NULL CHECK(row_number>0), raw_data jsonb NOT NULL, normalized_data jsonb NOT NULL,
 validation_status varchar(20) NOT NULL CHECK(validation_status IN ('PENDING','VALID','INVALID','DUPLICATE','IMPORTED','SKIPPED','ROLLED_BACK')),
 validation_errors jsonb NOT NULL, course_attempt_id uuid, imported_at timestamptz,
 created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(batch_id,row_number)
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL, module_code text NOT NULL,
 entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address inet, request_id text,
 created_at timestamptz DEFAULT now()
);
INSERT INTO institutions(id) VALUES ('${ids.institution}');
INSERT INTO users(id) VALUES ('${ids.actor}');
`;

const rows = [
  { rowNumber: 2, raw: { studentNumber: "IDMC/2024/00001" }, normalized: { student_number: "IDMC/2024/00001" }, validationStatus: "VALID", errors: [] },
  { rowNumber: 3, raw: { studentNumber: "BAD" }, normalized: {}, validationStatus: "INVALID", errors: ["UNKNOWN_STUDENT_NUMBER"] },
];
const payload = batchNumber => ({ batch_number: batchNumber, institution_id: ids.institution,
  source_format: "CSV", source_file_name: "records.csv", source_file_sha256: "a".repeat(64),
  total_rows: 2, valid_rows: 1, invalid_rows: 1, duplicate_rows: 0 });

async function create(db, batchNumber) {
  return db.query(`SELECT public.create_historical_academic_import_batch($1::jsonb,$2::jsonb,$3,$4,$5::inet) AS batch`,
    [JSON.stringify(payload(batchNumber)), JSON.stringify(rows), ids.actor, "create-request", "192.0.2.10"]);
}

test("academic import batch and rows save together with matching summary and audit", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    const result = await create(db, "ACAD-CREATE-1");
    assert.equal(result.rows[0].batch.status, "VALIDATED");
    assert.equal(result.rows[0].batch.created_by, ids.actor);
    const state = await db.query(`SELECT b.total_rows,b.valid_rows,b.invalid_rows,
      count(DISTINCT r.id)::integer AS rows,count(DISTINCT a.id)::integer AS audits,
      min(a.request_id) AS request_id,min(a.ip_address::text) AS ip_address
      FROM historical_academic_import_batches b
      JOIN historical_academic_import_rows r ON r.batch_id=b.id
      JOIN audit_logs a ON a.entity_id=b.id WHERE b.batch_number='ACAD-CREATE-1'
      GROUP BY b.id`);
    assert.deepEqual(state.rows[0], {
      total_rows: 2, valid_rows: 1, invalid_rows: 1, rows: 2, audits: 1,
      request_id: "create-request", ip_address: "192.0.2.10/32",
    });
    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.create_historical_academic_import_batch(jsonb,jsonb,uuid,text,inet)','EXECUTE') AS anon_call,
      has_function_privilege('service_role','public.create_historical_academic_import_batch(jsonb,jsonb,uuid,text,inet)','EXECUTE') AS service_call`);
    assert.equal(grants.rows[0].anon_call, false);
    assert.equal(grants.rows[0].service_call, true);
  } finally {
    await db.close();
  }
});

test("row or audit insertion failure rolls the entire batch save back", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec(`CREATE FUNCTION reject_second_import_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.row_number=3 THEN RAISE EXCEPTION 'test row insertion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_import_row BEFORE INSERT ON historical_academic_import_rows FOR EACH ROW EXECUTE FUNCTION reject_second_import_row();`);
    await assert.rejects(create(db, "ACAD-ROW-FAIL"), /test row insertion failure/);
    let counts = await db.query(`SELECT
      (SELECT count(*)::integer FROM historical_academic_import_batches) AS batches,
      (SELECT count(*)::integer FROM historical_academic_import_rows) AS rows,
      (SELECT count(*)::integer FROM audit_logs) AS audits`);
    assert.deepEqual(counts.rows[0], { batches: 0, rows: 0, audits: 0 });
    await db.exec("DROP TRIGGER reject_second_import_row ON historical_academic_import_rows; DROP FUNCTION reject_second_import_row();");

    await db.exec(`CREATE FUNCTION reject_batch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action_code='HISTORICAL_ACADEMIC_VALIDATE' THEN RAISE EXCEPTION 'test batch audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_batch_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_batch_audit();`);
    await assert.rejects(create(db, "ACAD-AUDIT-FAIL"), /test batch audit failure/);
    counts = await db.query(`SELECT
      (SELECT count(*)::integer FROM historical_academic_import_batches) AS batches,
      (SELECT count(*)::integer FROM historical_academic_import_rows) AS rows,
      (SELECT count(*)::integer FROM audit_logs) AS audits`);
    assert.deepEqual(counts.rows[0], { batches: 0, rows: 0, audits: 0 });
  } finally {
    await db.close();
  }
});

test("batch creation route delegates persistence and audit to the atomic RPC", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /rpc\("create_historical_academic_import_batch"/);
  assert.doesNotMatch(source, /from\("historical_academic_import_batches"\)\.insert/);
  assert.doesNotMatch(source, /from\("historical_academic_import_rows"\)\.insert/);
});
