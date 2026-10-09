import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

Object.assign(process.env, {
  NODE_ENV: "test", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "test-key-only",
  JWT_SECRET: "test-secret-at-least-sixteen", SMTP_HOST: "localhost", SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "test-only", SMTP_FROM_EMAIL: "test@example.com",
});
const { default: app } = await import("../dist/app.js");
const { getSupabase } = await import("../dist/config/database.js");

const migrationUrl = new URL("../../../supabase/migrations/20261007270000_library_active_reservation_unique.sql", import.meta.url);
const routeUrl = new URL("../src/modules/student-engagement/student-engagement.routes.ts", import.meta.url);
const schema = `
CREATE TABLE public.library_members(id uuid PRIMARY KEY, student_id uuid NOT NULL);
CREATE TABLE public.library_items(id uuid PRIMARY KEY);
CREATE TABLE public.library_reservations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), library_member_id uuid NOT NULL REFERENCES public.library_members(id),
 library_item_id uuid NOT NULL REFERENCES public.library_items(id), reservation_status text NOT NULL,
 CONSTRAINT reservation_status_valid CHECK (reservation_status IN ('ACTIVE','FULFILLED','EXPIRED','CANCELLED'))
);
`;
const member = "11111111-1111-4111-8111-111111111111";
const item = "22222222-2222-4222-8222-222222222222";

test("library migration blocks duplicate active reservations and allows a new reservation after cancellation", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query("INSERT INTO library_members(id,student_id) VALUES ($1,$1)", [member]);
    await db.query("INSERT INTO library_items(id) VALUES ($1)", [item]);
    await db.exec(await readFile(migrationUrl, "utf8"));
    await db.query("INSERT INTO library_reservations(library_member_id,library_item_id,reservation_status) VALUES ($1,$2,'ACTIVE')", [member, item]);
    await assert.rejects(
      db.query("INSERT INTO library_reservations(library_member_id,library_item_id,reservation_status) VALUES ($1,$2,'ACTIVE')", [member, item]),
      error => error.code === "23505",
    );
    await db.query("UPDATE library_reservations SET reservation_status='CANCELLED' WHERE library_member_id=$1 AND library_item_id=$2", [member, item]);
    await db.query("INSERT INTO library_reservations(library_member_id,library_item_id,reservation_status) VALUES ($1,$2,'ACTIVE')", [member, item]);
    await db.query("INSERT INTO library_reservations(library_member_id,library_item_id,reservation_status) VALUES ($1,$2,'FULFILLED')", [member, item]);
    const result = await db.query("SELECT count(*)::integer AS active_count FROM library_reservations WHERE library_member_id=$1 AND library_item_id=$2 AND reservation_status='ACTIVE'", [member, item]);
    assert.equal(result.rows[0].active_count, 1);
    await db.exec(await readFile(migrationUrl, "utf8"));
  } finally { await db.close(); }
});

test("library migration refuses to mask pre-existing duplicate active reservations", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query("INSERT INTO library_members(id,student_id) VALUES ($1,$1)", [member]);
    await db.query("INSERT INTO library_items(id) VALUES ($1)", [item]);
    await db.query("INSERT INTO library_reservations(library_member_id,library_item_id,reservation_status) VALUES ($1,$2,'ACTIVE'),($1,$2,'ACTIVE')", [member, item]);
    await assert.rejects(db.exec(await readFile(migrationUrl, "utf8")), error => error.code === "23505" && /duplicate member\/item pairs need manual review/.test(error.message));
    await db.exec("ROLLBACK");
    const indexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='library_reservations' AND indexname='uq_library_reservations_active_member_item'");
    assert.equal(indexes.rows.length, 0);
  } finally { await db.close(); }
});

test("student library reservation route translates the uniqueness race into HTTP 409", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /if\(q\.error\.code==="23505"\)throw httpError\("You already have an active reservation for this item\.",409\)/);
  assert.match(source, /\.eq\("reservation_status","ACTIVE"\)/);
});

test("library reservation HTTP endpoint returns 409 when PostgreSQL rejects the concurrent duplicate", async () => {
  const db = getSupabase(), oldFrom = db.from, oldGetUser = db.auth.getUser;
  const seen = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.inserted = null; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    maybeSingle() { return Promise.resolve(this.resolve(true)); }
    single() { return Promise.resolve(this.resolve(true)); }
    insert(value) { this.inserted = value; return this; }
    then(resolve, reject) { return Promise.resolve(this.resolve()).then(resolve, reject); }
    resolve(single = false) {
      seen.push(this.table);
      if (this.inserted) return { data: null, error: { code: "23505", message: "duplicate active reservation" } };
      let rows = [];
      if (this.table === "users") rows = [{ id: "user-1", auth_user_id: "auth-1", status: "ACTIVE" }];
      if (this.table === "user_roles") rows = [{ user_id: "user-1", status: "ACTIVE", expires_at: null, roles: { status: "ACTIVE", role_permissions: [{ permissions: { status: "ACTIVE", permission_code: "students.self.manage" } }] } }];
      if (this.table === "students") rows = [{ id: "student-1", user_id: "user-1" }];
      if (this.table === "library_members") rows = [{ id: "member-1", student_id: "student-1", membership_status: "ACTIVE" }];
      if (this.table === "library_items") rows = [{ id: "item-1", item_status: "AVAILABLE" }];
      if (this.table === "library_reservations") rows = [];
      for (const [key, value] of this.filters) rows = rows.filter(row => row[key] === value);
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
  }
  db.auth.getUser = async () => ({ data: { user: { id: "auth-1", email: "test@example.com" } }, error: null });
  db.from = table => new Query(table);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/student-engagement/library/reservations`, {
      method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ libraryItemId: "item-1" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /already have an active reservation/i);
    assert.ok(seen.includes("library_reservations"));
  } finally { await new Promise(resolve => server.close(resolve)); db.from = oldFrom; db.auth.getUser = oldGetUser; }
});
