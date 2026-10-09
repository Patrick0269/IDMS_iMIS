import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../../supabase/migrations/20261007230000_refund_reservation_integrity.sql", import.meta.url);
const paymentMigration = new URL("../../../supabase/migrations/20261007240000_payment_refund_capacity_integrity.sql", import.meta.url);
const routeSource = new URL("../src/modules/student-engagement/student-engagement.routes.ts", import.meta.url);

const ids = {
  student: "11111111-1111-4111-8111-111111111111",
  otherStudent: "22222222-2222-4222-8222-222222222222",
  payment: "33333333-3333-4333-8333-333333333333",
  otherPayment: "44444444-4444-4444-8444-444444444444",
  requested: "55555555-5555-4555-8555-555555555555",
  rejected: "66666666-6666-4666-8666-666666666666",
  second: "77777777-7777-4777-8777-777777777777",
};

const schema = `
CREATE TABLE public.students(id uuid PRIMARY KEY);
CREATE TABLE public.payments(id uuid PRIMARY KEY, student_id uuid NOT NULL REFERENCES public.students(id), amount numeric(18,2) NOT NULL);
CREATE TABLE public.refunds(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES public.payments(id),
 student_id uuid NOT NULL REFERENCES public.students(id), amount numeric(18,2) NOT NULL CHECK(amount > 0),
 status text NOT NULL CHECK(status IN ('REQUESTED','APPROVED','PROCESSING','PAID','REJECTED','CANCELLED'))
);
`;

async function assertPgError(run, code) {
  await assert.rejects(run, error => error.code === code);
}

test("refund trigger reserves pending amounts and locks the payment row before checking the cap", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec(await readFile(paymentMigration, "utf8"));
    await db.query("INSERT INTO students(id) VALUES ($1),($2)", [ids.student, ids.otherStudent]);
    await db.query("INSERT INTO payments(id,student_id,amount) VALUES ($1,$2,100),($3,$4,250)", [ids.payment, ids.student, ids.otherPayment, ids.otherStudent]);
    await db.query("INSERT INTO refunds(id,payment_id,student_id,amount,status) VALUES ($1,$2,$3,60,'REQUESTED'),($4,$2,$3,90,'REJECTED')", [ids.requested, ids.payment, ids.student, ids.rejected]);

    await assertPgError(() => db.query("INSERT INTO refunds(payment_id,student_id,amount,status) VALUES ($1,$2,50,'REQUESTED')", [ids.payment, ids.student]), "23514");
    await db.query("INSERT INTO refunds(id,payment_id,student_id,amount,status) VALUES ($1,$2,$3,40,'REQUESTED')", [ids.second, ids.payment, ids.student]);
    await assertPgError(() => db.query("UPDATE refunds SET status='APPROVED' WHERE id=$1", [ids.rejected]), "23514");

    await db.query("UPDATE refunds SET status='CANCELLED' WHERE id=$1", [ids.requested]);
    await assertPgError(() => db.query("UPDATE refunds SET status='APPROVED' WHERE id=$1", [ids.rejected]), "23514");
    await db.query("UPDATE refunds SET status='CANCELLED' WHERE id=$1", [ids.second]);
    await db.query("UPDATE refunds SET status='APPROVED' WHERE id=$1", [ids.rejected]);
    await db.query("INSERT INTO refunds(payment_id,student_id,amount,status) VALUES ($1,$2,10,'REQUESTED')", [ids.payment, ids.student]);

    await assertPgError(() => db.query("UPDATE payments SET amount=99 WHERE id=$1", [ids.payment]), "23514");
    await assertPgError(() => db.query("UPDATE payments SET student_id=$1 WHERE id=$2", [ids.otherStudent, ids.payment]), "23514");
    await db.query("UPDATE payments SET amount=150 WHERE id=$1", [ids.payment]);

    await assertPgError(() => db.query("INSERT INTO refunds(payment_id,student_id,amount,status) VALUES ($1,$2,1,'REQUESTED')", [ids.payment, ids.otherStudent]), "23514");
    await assertPgError(() => db.query("UPDATE refunds SET payment_id=$1 WHERE id=$2", [ids.otherPayment, ids.rejected]), "23514");
    const state = await db.query("SELECT SUM(amount) AS reserved FROM refunds WHERE payment_id=$1 AND status IN ('REQUESTED','APPROVED','PROCESSING','PAID')", [ids.payment]);
    assert.equal(Number(state.rows[0].reserved), 100);

    const definition = await db.query("SELECT pg_get_functiondef('public.validate_refund_integrity()'::regprocedure) AS source");
    assert.match(definition.rows[0].source, /FOR UPDATE/);
    assert.match(definition.rows[0].source, /'REQUESTED', 'APPROVED', 'PROCESSING', 'PAID'/);
    const paymentDefinition = await db.query("SELECT pg_get_functiondef('public.validate_payment_refund_capacity()'::regprocedure) AS source");
    assert.match(paymentDefinition.rows[0].source, /'REQUESTED', 'APPROVED', 'PROCESSING', 'PAID'/);
  } finally {
    await db.close();
  }
});

test("student refund API rejects sub-cent amounts and delegates final limits to PostgreSQL", async () => {
  const route = await readFile(routeSource, "utf8");
  assert.match(route, /Number\.isInteger\(amount\*100\)/);
  assert.match(route, /in\("status",\["REQUESTED","APPROVED","PROCESSING","PAID"\]\)/);
  assert.match(route, /if\(q\.error\)throw q\.error;return q\.data/);
});

test("staff refund mutations use the audited state workflow instead of generic CRUD writes", async () => {
  const financeRoute = await readFile(new URL("../src/modules/finance/routes/finance.routes.ts", import.meta.url), "utf8");
  const crud = await readFile(new URL("../src/utils/resourceCrud.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../../frontend/assets/js/idmc-resource-page.js", import.meta.url), "utf8");
  assert.match(financeRoute, /router\.post\("\/refunds\/:id\/action"/);
  assert.match(financeRoute, /current\.data\.requested_by === actorId/);
  assert.match(financeRoute, /\.eq\("status", expectedStatus\)/);
  assert.match(financeRoute, /createAuditLog\(\{ actorUserId: actorId/);
  assert.match(financeRoute, /allowCreate:false,allowUpdate:false,allowDelete:false/);
  assert.match(crud, /if \(config\.allowCreate !== false\)/);
  assert.match(crud, /if \(config\.allowUpdate !== false\)/);
  assert.match(page, /refundAction\(row\)/);
  assert.match(page, /runRefundAction\(b\)/);
});
