import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "test-key-only",
  JWT_SECRET: "test-secret-at-least-sixteen", SMTP_HOST: "localhost", SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "test-only", SMTP_FROM_EMAIL: "test@example.com",
});
const { default: app } = await import("../dist/app.js");
const { getSupabase } = await import("../dist/config/database.js");

class FakeQuery {
  constructor(table, state) { this.table = table; this.state = state; this.filters = []; this.selection = ""; this.limitValue = 1000; }
  select(value) { this.selection = value; this.state.selects.push({ table: this.table, value }); return this; }
  eq(field, value) { this.filters.push({ kind: "eq", field, value }); return this; }
  in(field, values) { this.filters.push({ kind: "in", field, values }); return this; }
  order() { return this; }
  limit(value) { this.limitValue = value; return this; }
  maybeSingle() { return Promise.resolve(this.resolve(true)); }
  then(resolve, reject) { return Promise.resolve(this.resolve()).then(resolve, reject); }
  resolve(single = false) {
    this.state.queries.push({ table: this.table, selection: this.selection, filters: this.filters });
    let rows = this.state.data[this.table] ?? [];
    if (this.table === "staff" && this.filters.some(filter => filter.field === "user_id")) rows = this.state.currentStaff ? [this.state.currentStaff] : [];
    if (this.table === "user_roles") rows = this.state.role ? [this.state.role] : [];
    rows = rows.filter(row => this.filters.every(filter => filter.kind === "eq" ? row[filter.field] === filter.value : filter.values.includes(row[filter.field])));
    rows = rows.slice(0, this.limitValue);
    const selected = rows.map(row => {
      if (this.table === "user_roles") return row;
      if (!this.selection || this.selection === "*") return row;
      const keys = this.selection.split(",").map(key => key.trim());
      return Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    });
    return { data: single ? selected[0] ?? null : selected, error: null };
  }
}

async function withServer(roleCode, callback, options = {}) {
  const db = getSupabase(), oldFrom = db.from, oldGetUser = db.auth.getUser;
  const institutionId = "idms-1";
  const state = {
    queries: [], selects: [],
    role: { user_id: "user-1", status: "ACTIVE", expires_at: null, roles: { role_code: roleCode, status: "ACTIVE" } },
    currentStaff: options.noStaff ? null : { id: "staff-1", user_id: "user-1", institution_id: institutionId, employee_number: "E-1", first_name: "Asha", last_name: "Musa", job_title: "HR Officer" },
    data: {
      users: [{ id: "user-1", auth_user_id: "auth-1", status: "ACTIVE", user_number: "U1", email: "test@example.com", first_name: "Asha", last_name: "Musa" }],
      programmes: [{ id: "programme-1", institution_id: institutionId }],
      students: [{ id: "student-1", programme_id: "programme-1", user_id: "student-user-1", student_number: "IDMS/2026/1", student_status: "ACTIVE" }, { id: "other-student", programme_id: "other-programme", user_id: "other-user", student_number: "OTHER/1", student_status: "ACTIVE" }],
      staff: [{ id: "staff-1", user_id: "user-1", institution_id: institutionId, employee_number: "E-1", first_name: "Asha", last_name: "Musa", job_title: "HR Officer", employment_status: "ACTIVE" }, { id: "other-staff", user_id: "user-2", institution_id: "other-tenant", employee_number: "E-2", first_name: "Other", last_name: "Tenant", employment_status: "ACTIVE" }],
      course_offerings: [{ id: "offering-1", programme_id: "programme-1" }],
      application_choices: [{ id: "choice-1", programme_id: "programme-1", application_id: "application-1" }],
      examination_papers: [{ id: "paper-1", course_offering_id: "offering-1", examination_period_id: "period-1" }],
      examination_candidates: [{ id: "candidate-1", examination_paper_id: "paper-1", student_id: "student-1" }],
      examination_marks: [{ id: "mark-1", examination_candidate_id: "candidate-1" }],
      library_members: [{ id: "member-1", institution_id: institutionId }], inventory_items: [{ id: "inventory-1", institution_id: institutionId }],
      staff_leave_requests: [{ id: "leave-1", staff_id: "staff-1", request_number: "LR-1", request_status: "PENDING", reason: "private reason" }, { id: "leave-2", staff_id: "other-staff", request_number: "LR-2", request_status: "PENDING" }],
      staff_attendance: [{ id: "attendance-1", staff_id: "staff-1", attendance_date: "2026-10-06", attendance_status: "PRESENT", check_in: "08:00" }],
      staff_payroll_entries: [{ id: "payroll-1", staff_id: "staff-1", status: "APPROVED", currency_code: "TZS", paid_at: null, payment_reference: "PAY-1", bank_account_number: "SECRET-ACCOUNT", basic_salary: 999999 }],
    },
  };
  db.auth.getUser = async () => ({ data: { user: { id: "auth-1", email: "test@example.com" } }, error: null });
  db.from = table => new FakeQuery(table, state);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise(resolve => server.close(resolve)); db.from = oldFrom; db.auth.getUser = oldGetUser; }
}

test("Staff Operations returns role queues scoped to the linked staff institution and projects safe payroll fields", async () => {
  await withServer("HR_OFFICER", async (base, state) => {
    const response = await fetch(`${base}/api/v1/staff-operations/overview`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.data.sections.length, 1);
    assert.equal(body.data.sections[0].code, "hr");
    const queues = body.data.sections[0].queues;
    assert.deepEqual(queues.find(queue => queue.table === "staff_leave_requests").rows.map(row => row.request_number), ["LR-1"]);
    const payroll = queues.find(queue => queue.table === "staff_payroll_entries").rows[0];
    assert.deepEqual(Object.keys(payroll).sort(), ["currency_code", "paid_at", "payment_reference", "status"]);
    assert.doesNotMatch(JSON.stringify(body), /SECRET-ACCOUNT|999999|private reason|OTHER\/1/);
    const staffQuery = state.queries.find(query => query.table === "staff" && query.filters.some(filter => filter.field === "institution_id"));
    assert.ok(staffQuery);
    assert.equal(staffQuery.filters.some(filter => filter.field === "institution_id" && filter.values?.includes("other-tenant")), false);
    const payrollSelect = state.selects.find(query => query.table === "staff_payroll_entries");
    assert.equal(payrollSelect.value.includes("bank_account_number"), false);
    assert.equal(payrollSelect.value, "id,status,currency_code,paid_at,payment_reference");
  });
});

test("Staff Operations denies users without a staff profile institution scope", async () => {
  await withServer("ADMIN", async (base, state) => {
    state.currentStaff = null;
    const response = await fetch(`${base}/api/v1/staff-operations/overview`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 403);
    assert.equal(state.queries.some(query => query.table === "programmes"), false);
  });
});

test("Staff Operations denies roles that have no operational section", async () => {
  await withServer("STUDENT", async base => {
    const response = await fetch(`${base}/api/v1/staff-operations/overview`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 403);
  });
});
