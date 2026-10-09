import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const backend = new URL("../src/modules/student-requests/student-requests.routes.ts", import.meta.url);
const frontend = new URL("../../frontend/", import.meta.url);

test("HOD can process calculated results through controlled student and bulk workflows", async () => {
  const source = await readFile(backend, "utf8");
  assert.match(source, /CALCULATED.*SUBMITTED/s);
  assert.match(source, /results\/students\/:studentId\/\$\{action\}/);
  assert.match(source, /results\/bulk\/\$\{action\}/);
  assert.match(source, /result_status: "SUBMITTED"/);
  assert.match(source, /result_status: transition\.to/);
});

test("HOD request queue includes Student Portal service requests", async () => {
  const source = await readFile(backend, "utf8");
  assert.match(source, /student_service_requests/);
  assert.match(source, /serviceRequestRowsForScope/);
  assert.match(source, /course_add_drop_requests/);
});

test("HOD results interface groups students and keeps the existing verification workflow", async () => {
  const html = await readFile(new URL("student-requests.html", frontend), "utf8");
  const script = await readFile(new URL("assets/js/student-requests.js", frontend), "utf8");
  assert.match(html, /HOD Academic Desk/i);
  assert.match(html, /HOD_VERIFIED/);
  assert.match(html, /CALCULATED/);
  assert.match(script, /student_id.*academic_year_id.*semester_id/);
  assert.match(script, /Verify Results for Examination Review/);
  assert.match(script, /Only PUBLISHED\/LOCKED results appear in the Student Portal/);
  assert.doesNotMatch(script, /Publish to Student|Publish All Approved/);
});
