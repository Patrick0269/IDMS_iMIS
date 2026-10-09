import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "test-key-only",
  JWT_SECRET: "test-secret-at-least-sixteen", SMTP_HOST: "localhost", SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "test-only", SMTP_FROM_EMAIL: "test@example.com",
});
const { getSupabase } = await import("../dist/config/database.js");
const { default: workflowRoutes } = await import("../dist/modules/workflows/workflow.routes.js");
const { errorHandler } = await import("../dist/middleware/errorHandler.js");

test("legacy application conversion requires admissions.manage before reading or converting records", async () => {
  const db = getSupabase();
  const oldFrom = db.from;
  const oldRpc = db.rpc;
  const oldGetUser = db.auth.getUser;
  const tables = [];
  let rpcCalls = 0;
  db.auth.getUser = async () => ({ data: { user: { id: "auth-user", email: "test@example.com" } }, error: null });
  db.rpc = async () => { rpcCalls++; return { data: "student-1", error: null }; };
  db.from = table => {
    tables.push(table);
    const query = {
      select() { return this; },
      eq() { return this; },
      maybeSingle() {
        if (table === "users") return Promise.resolve({ data: { id: "user-1", auth_user_id: "auth-user", user_number: "U-1", email: "test@example.com", first_name: "Test", last_name: "User", status: "ACTIVE" }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        const data = table === "user_roles" ? [{ status: "ACTIVE", expires_at: null, roles: { status: "ACTIVE", role_code: "STUDENT", role_permissions: [{ permissions: { status: "ACTIVE", permission_code: "students.view" } }] } }] : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  const app = express();
  app.use(express.json());
  app.use("/workflows", workflowRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/workflows/admission-applications/application-1/convert-to-student`, {
      method: "POST", headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 403, await response.clone().text());
    assert.deepEqual(tables, ["users", "user_roles"]);
    assert.equal(rpcCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.from = oldFrom;
    db.rpc = oldRpc;
    db.auth.getUser = oldGetUser;
  }
});

test("staff acceptance and decline delegate their complete transition context to the atomic RPC", async () => {
  const db = getSupabase();
  const oldFrom = db.from, oldRpc = db.rpc, oldGetUser = db.auth.getUser;
  const rpcCalls = [];
  db.auth.getUser = async () => ({ data: { user: { id: "auth-user", email: "test@example.com" } }, error: null });
  db.from = table => ({
    select() { return this; }, eq() { return this; },
    maybeSingle() {
      return Promise.resolve(table === "users"
        ? { data: { id: "user-1", auth_user_id: "auth-user", user_number: "U-1", email: "test@example.com", first_name: "Test", last_name: "User", status: "ACTIVE" }, error: null }
        : { data: null, error: null });
    },
    then(resolve, reject) {
      const data = table === "user_roles" ? [{ status: "ACTIVE", expires_at: null, roles: { status: "ACTIVE", role_code: "ADMISSIONS_OFFICER", role_permissions: [{ permissions: { status: "ACTIVE", permission_code: "admissions.accept" } }] } }] : [];
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  });
  db.rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: { id: args.p_acceptance_id, acceptance_status: args.p_status }, error: null };
  };
  const app = express();
  app.use(express.json());
  app.use("/workflows", workflowRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/workflows/admission-acceptances/acceptance-1`;
    const accepted = await fetch(`${base}/accept`, { method: "POST", headers: { Authorization: "Bearer test-token" } });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal(rpcCalls[0].name, "transition_admission_acceptance_atomic");
    assert.equal(rpcCalls[0].args.p_status, "ACCEPTED");
    assert.equal(rpcCalls[0].args.p_actor_id, "user-1");
    assert.ok(Object.hasOwn(rpcCalls[0].args, "p_request_id"));

    const missingReason = await fetch(`${base}/decline`, { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(missingReason.status, 400);
    assert.equal(rpcCalls.length, 1);

    const declined = await fetch(`${base}/decline`, { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Applicant declined the offer" }) });
    assert.equal(declined.status, 200, await declined.clone().text());
    assert.equal(rpcCalls[1].args.p_status, "DECLINED");
    assert.equal(rpcCalls[1].args.p_reason, "Applicant declined the offer");
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.from = oldFrom;
    db.rpc = oldRpc;
    db.auth.getUser = oldGetUser;
  }
});
