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
  constructor(table, state) { this.table = table; this.state = state; this.filters = []; this.limitValue = null; this.expression = ""; }
  select(value) { this.state.selects.push([this.table, value]); return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  is(key, value) { this.filters.push([key, { is: value }]); return this; }
  or(value) { this.expression = value; return this; }
  order() { return this; }
  limit(value) { this.limitValue = value; return this; }
  maybeSingle() { return Promise.resolve(this.resolve(true)); }
  then(resolve, reject) { return Promise.resolve(this.resolve()).then(resolve, reject); }
  resolve(single = false) {
    this.state.tables.push(this.table);
    let rows = [];
    if (this.table === "users") rows = [{ id: "user-1", auth_user_id: "auth-1", status: "ACTIVE" }];
    if (this.table === "user_roles" && this.state.permission) rows = [{
      user_id: "user-1", status: "ACTIVE", expires_at: null,
      roles: { status: "ACTIVE", role_permissions: [{ permissions: { status: "ACTIVE", permission_code: this.state.permission } }] },
    }];
    if (this.table === "students") rows = this.state.students;
    if (this.table === "student_transcripts") rows = this.state.transcripts;
    if (this.table === "student_transcript_semesters") rows = this.state.semesters;
    if (this.table === "student_transcript_courses") rows = this.state.courses;
    for (const [key, value] of this.filters) rows = rows.filter(row => value?.is !== undefined ? row[key] === value.is : row[key] === value);
    if (this.limitValue !== null) rows = rows.slice(0, this.limitValue);
    return { data: single ? rows[0] ?? null : rows, error: null };
  }
}

async function withTranscriptServer(permission, callback) {
  const db = getSupabase(), oldFrom = db.from, oldGetUser = db.auth.getUser;
  const state = {
    permission, tables: [], selects: [], queries: [],
    students: [{ id: "student-1", student_number: "IDMS/2026/0001", first_name: "Asha", middle_name: null, last_name: "Musa", student_status: "ACTIVE", archived_at: null }],
    transcripts: [{ id: "transcript-1", transcript_number: "TR-1", transcript_status: "GENERATED", transcript_type: "OFFICIAL", cumulative_earned_credits: 30, cgpa: 3.5 }],
    semesters: [{ id: "semester-line-1", transcript_id: "transcript-1", sequence_no: 1, gpa: 3.5, earned_credits: 30 }],
    courses: [{ id: "course-line-1", transcript_id: "transcript-1", display_sequence: 1, course_code: "CSC101", course_name: "Programming", credits: 10, grade_code: "A", grade_point: 4 }],
  };
  db.auth.getUser = async () => ({ data: { user: { id: "auth-1", email: "test@example.com" } }, error: null });
  db.from = table => { const query = new FakeQuery(table, state); state.queries.push(query); return query; };
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise(resolve => server.close(resolve)); db.from = oldFrom; db.auth.getUser = oldGetUser; }
}

const auth = { Authorization: "Bearer test-token" };

test("transcript student reference search requires view permission and returns bounded matches", async () => {
  await withTranscriptServer("transcripts.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/reference-data/students?search=Asha`);
    assert.equal(response.status, 401);
    assert.equal(state.tables.includes("students"), false);
  });
  await withTranscriptServer("transcripts.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/reference-data/students?search=Asha%25`, { headers: auth });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].student_number, "IDMS/2026/0001");
    const studentQuery = state.selects.find(([table]) => table === "students");
    assert.deepEqual(studentQuery, ["students", "id,student_number,first_name,middle_name,last_name,student_status"]);
    const query = state.queries.find(item => item.table === "students");
    assert.equal(query.limitValue, 50);
    assert.deepEqual(query.filters.find(([key]) => key === "archived_at"), ["archived_at", { is: null }]);
    assert.equal(query.expression, "student_number.ilike.%Asha%,first_name.ilike.%Asha%,middle_name.ilike.%Asha%,last_name.ilike.%Asha%");
    assert.equal(state.tables.includes("students"), true);
  });
  await withTranscriptServer("students.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/reference-data/students?search=Asha`, { headers: auth });
    assert.equal(response.status, 403);
    assert.equal(state.tables.includes("students"), false);
  });
  await withTranscriptServer("transcripts.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/reference-data/students?search=A`, { headers: auth });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
    assert.equal(state.tables.includes("students"), false);
  });
});

test("transcript snapshot returns stored lines only to authorized viewers", async () => {
  await withTranscriptServer("transcripts.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/transcript-1/snapshot`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.transcript.transcript_number, "TR-1");
    assert.equal(body.data.semesters[0].sequence_no, 1);
    assert.equal(body.data.courses[0].course_code, "CSC101");
    assert.ok(state.tables.includes("student_transcript_semesters"));
    assert.ok(state.tables.includes("student_transcript_courses"));
  });
  await withTranscriptServer("results.view", async (base, state) => {
    const response = await fetch(`${base}/api/v1/transcripts/transcript-1/snapshot`, { headers: auth });
    assert.equal(response.status, 403);
    assert.equal(state.tables.includes("student_transcripts"), false);
  });
});
