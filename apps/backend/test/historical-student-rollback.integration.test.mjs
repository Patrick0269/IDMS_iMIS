import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../../supabase/migrations/20261007170000_historical_student_rollback_atomic.sql", import.meta.url);
const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  batch: "22222222-2222-4222-8222-222222222222",
  row: "33333333-3333-4333-8333-333333333333",
  student: "44444444-4444-4444-8444-444444444444",
  mismatchBatch: "55555555-5555-4555-8555-555555555555",
  mismatchRow: "66666666-6666-4666-8666-666666666666",
  unownedStudent: "77777777-7777-4777-8777-777777777777",
};

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.historical_import_batches(
 id uuid PRIMARY KEY, batch_number text NOT NULL, status text NOT NULL,
 rolled_back_by uuid, rolled_back_at timestamptz, rollback_reason text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.students(
 id uuid PRIMARY KEY, student_status text NOT NULL, archived_at timestamptz,
 archived_by uuid, notes text, updated_at timestamptz DEFAULT now(),
 source_reference text, source_type text
);
CREATE TABLE public.historical_import_rows(
 id uuid PRIMARY KEY, batch_id uuid NOT NULL, student_id uuid,
 validation_status text NOT NULL, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.audit_logs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_code text NOT NULL,
 module_code text NOT NULL, entity_type text, entity_id uuid,
 old_values jsonb, new_values jsonb, ip_address inet, request_id text,
 created_at timestamptz DEFAULT now()
);
`;

test("historical student import rollback commits students, rows, batch and audit together", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_import_batches(id,batch_number,status) VALUES ($1,'HIST-2026-01','COMPLETED')", [ids.batch]);
    await db.query("INSERT INTO students(id,student_status,source_reference,source_type) VALUES ($1,'PENDING_ACTIVATION','HIST-2026-01','HISTORICAL_IMPORT')", [ids.student]);
    await db.query("INSERT INTO historical_import_rows(id,batch_id,student_id,validation_status) VALUES ($1,$2,$3,'IMPORTED')", [ids.row, ids.batch, ids.student]);

    const result = await db.query(
      "SELECT public.rollback_historical_student_import($1,$2,$3,$4,$5::inet) AS batch",
      [ids.batch, ids.actor, "Incorrect cohort mapping", "request-123", "192.0.2.8"],
    );
    assert.equal(result.rows[0].batch.status, "ROLLED_BACK");
    assert.equal(result.rows[0].batch.rollback_reason, "Incorrect cohort mapping");
    const state = await db.query(`
      SELECT s.student_status, s.archived_by, s.notes, r.validation_status, b.status AS batch_status,
             a.action_code, a.request_id, a.ip_address::text AS ip_address
        FROM students s
        JOIN historical_import_rows r ON r.student_id=s.id
        JOIN historical_import_batches b ON b.id=r.batch_id
        JOIN audit_logs a ON a.entity_id=b.id
       WHERE s.id=$1`, [ids.student]);
    assert.equal(state.rows[0].student_status, "INACTIVE");
    assert.equal(state.rows[0].archived_by, ids.actor);
    assert.match(state.rows[0].notes, /Incorrect cohort mapping/);
    assert.equal(state.rows[0].validation_status, "ROLLED_BACK");
    assert.equal(state.rows[0].batch_status, "ROLLED_BACK");
    assert.equal(state.rows[0].action_code, "HISTORICAL_IMPORT_ROLLBACK");
    assert.equal(state.rows[0].request_id, "request-123");
    assert.equal(state.rows[0].ip_address, "192.0.2.8/32");
  } finally {
    await db.close();
  }
});

test("historical student rollback rejects mismatched ownership without partial writes", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.query("INSERT INTO historical_import_batches(id,batch_number,status) VALUES ($1,'HIST-2026-02','COMPLETED_WITH_ERRORS')", [ids.mismatchBatch]);
    await db.query("INSERT INTO students(id,student_status,source_reference,source_type) VALUES ($1,'ACTIVE','OTHER-BATCH','HISTORICAL_IMPORT')", [ids.unownedStudent]);
    await db.query("INSERT INTO historical_import_rows(id,batch_id,student_id,validation_status) VALUES ($1,$2,$3,'IMPORTED')", [ids.mismatchRow, ids.mismatchBatch, ids.unownedStudent]);

    await assert.rejects(
      db.query("SELECT public.rollback_historical_student_import($1,$2,'Mistake')", [ids.mismatchBatch, ids.actor]),
      error => error.code === "23514",
    );
    const state = await db.query(`
      SELECT b.status AS batch_status, s.student_status, r.validation_status,
             (SELECT count(*) FROM audit_logs) AS audit_count
        FROM historical_import_batches b
        JOIN historical_import_rows r ON r.batch_id=b.id
        JOIN students s ON s.id=r.student_id
       WHERE b.id=$1`, [ids.mismatchBatch]);
    assert.deepEqual(state.rows[0], {
      batch_status: "COMPLETED_WITH_ERRORS", student_status: "ACTIVE",
      validation_status: "IMPORTED", audit_count: 0,
    });

    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.rollback_historical_student_import(uuid,uuid,text,text,inet)','EXECUTE') AS anon_call,
      has_function_privilege('service_role','public.rollback_historical_student_import(uuid,uuid,text,text,inet)','EXECUTE') AS service_call`);
    assert.equal(grants.rows[0].anon_call, false);
    assert.equal(grants.rows[0].service_call, true);
  } finally {
    await db.close();
  }
});
