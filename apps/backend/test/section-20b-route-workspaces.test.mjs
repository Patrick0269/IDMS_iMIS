import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const backend = new URL("../src/", import.meta.url);
const frontend = new URL("../../frontend/", import.meta.url);

test("institutional development is mounted and finance/payroll collection routes exist", async () => {
  const index = await readFile(new URL("routes/index.ts", backend), "utf8");
  const finance = await readFile(new URL("modules/finance/routes/finance.routes.ts", backend), "utf8");
  const hr = await readFile(new URL("modules/hr/hr.routes.ts", backend), "utf8");
  assert.match(index, /institutional-development/);
  for (const route of ["charges", "invoices", "payments", "scholarships", "refunds"]) assert.match(finance, new RegExp(`/${route}`));
  for (const route of ["periods", "components", "entries", "lines"]) assert.match(hr, new RegExp(`/payroll/${route}`));
});

test("academic reference endpoint supplies examination semester choices", async () => {
  const source = await readFile(new URL("modules/academic-core/academic-core.routes.ts", backend), "utf8");
  const workspace = await readFile(new URL("assets/js/institutional-workspace.js", frontend), "utf8");
  assert.match(source, /router\.get\("\/reference-data"/);
  assert.match(source, /semesters:"semesters"/);
  assert.match(workspace, /reference-data\?resource=semesters/);
});

test("repaired administration pages use modern workspaces", async () => {
  for (const name of ["finance.html", "hr.html", "payroll.html", "research.html", "hostel.html", "clinical-placement.html", "field-practical.html"]) {
    const html = await readFile(new URL(name, frontend), "utf8");
    assert.match(html, /institutional-workspace\.js/);
    assert.doesNotMatch(html, /Module Workspace|currently exposed as read-only|idmc-resource-page\.js/);
  }
});

test("finance sub-pages route to named modern workspace tabs", async () => {
  const pages = { "fee-structures.html":"feeStructures", "charges.html":"charges", "invoices.html":"invoices", "payments.html":"payments", "scholarships.html":"scholarships", "refunds.html":"refunds" };
  for (const [name, resource] of Object.entries(pages)) {
    const html = await readFile(new URL(name, frontend), "utf8");
    assert.match(html, new RegExp(`finance\\.html\\?resource=${resource}`));
  }
});

test("authoritative student finance records cannot be mutated through generic CRUD", async () => {
  const finance = await readFile(new URL("modules/finance/routes/finance.routes.ts", backend), "utf8");
  const workflow = await readFile(new URL("modules/finance/routes/finance-workflow.routes.ts", backend), "utf8");
  const page = await readFile(new URL("assets/js/idmc-resource-page.js", frontend), "utf8");
  for (const entity of ["student_charges", "invoices", "payments", "refunds"]) {
    const row = finance.split("\n").find(line => line.includes(`entityType:\"${entity}\"`));
    assert.ok(row, `generic CRUD config for ${entity} exists`);
    assert.match(row, /allowCreate:false,allowUpdate:false,allowDelete:false/);
  }
  assert.match(workflow, /\/students\/:studentId\/generate-invoice/);
  assert.match(workflow, /\/students\/:studentId\/payments/);
  assert.match(workflow, /\/payment-requests\/:id\/confirm/);
  for (const resource of ["charges", "invoices", "payments", "refunds"]) {
    const line = page.split("\n").find(item => item.includes(`\"${resource}\":`));
    assert.ok(line, `Finance UI config for ${resource} exists`);
    assert.match(line, /readOnly:true/);
  }
});

test("result and assessment records stay on calculation, marking and approval workflows", async () => {
  const results = await readFile(new URL("modules/results/results.routes.ts", backend), "utf8");
  const assessment = await readFile(new URL("modules/assessment/assessment.routes.ts", backend), "utf8");
  const workflow = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  for (const entity of ["course_results", "course_result_corrections", "student_semester_results", "student_academic_standings", "student_gpa_records"]) {
    const row = results.split("\n").find(line => line.includes(`entityType:\"${entity}\"`));
    assert.ok(row, `generic CRUD config for ${entity} exists`);
    assert.match(row, /allowCreate:false,allowUpdate:false,allowDelete:false/);
  }
  for (const entity of ["assessment_submissions", "assessment_marks", "assessment_mark_corrections"]) {
    const row = assessment.split("\n").find(line => line.includes(`entityType:\"${entity}\"`));
    assert.ok(row, `generic CRUD config for ${entity} exists`);
    assert.match(row, /allowCreate:false,allowUpdate:false,allowDelete:false/);
  }
  assert.match(assessment, /\/workspace\/assessments\/:id\/marks/);
  assert.match(workflow, /\/assessment-marks\/:id\/approve/);
  assert.match(workflow, /\/course-results\/:id\/calculate/);
  assert.match(workflow, /\/course-results\/:id\/submit/);
});

test("examination marks use validated draft entry and ordered four-eyes transitions", async () => {
  const exams = await readFile(new URL("modules/examinations/examinations.routes.ts", backend), "utf8");
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  const workspace = await readFile(new URL("assets/js/institutional-workspace.js", frontend), "utf8");
  const markCrud = exams.split("\n").find(line => line.includes("registerCrudResource") && line.includes('entityType:"examination_marks"'));
  assert.ok(markCrud);
  assert.match(markCrud, /allowCreate:false,allowUpdate:false,allowDelete:false/);
  assert.match(exams, /\/papers\/:id\/mark-roster/);
  assert.match(exams, /eligibility_status","ELIGIBLE/);
  assert.match(exams, /candidate_status","ACTIVE/);
  assert.match(exams, /\/marks\/entry/);
  assert.match(exams, /Number\.isInteger\(mark\*100\)/);
  assert.match(exams, /paper\.data\.maximum_marks/);
  assert.match(exams, /prior\.data\.status!=="DRAFT"/);
  assert.match(exams, /status:"DRAFT"/);
  assert.match(exams, /createAuditLog\(\{actorUserId:actorId/);
  assert.match(workflows, /if\(!from\.includes\(String\(current\.data\.status\)\)\)/);
  assert.match(workflows, /current\.data\.entered_by===actorId/);
  assert.match(workflows, /\.in\("status",from\)/);
  assert.match(workflows, /\["DRAFT"\],"SUBMITTED"/);
  assert.match(workflows, /\["SUBMITTED"\],"APPROVED"/);
  assert.match(workflows, /\["APPROVED"\],"LOCKED"/);
  assert.match(workspace, /data-exam-marks/);
  assert.match(workspace, /\/examinations\/marks\/entry/);
});

test("legacy application-to-student conversion route requires Admissions management permission", async () => {
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  assert.match(workflows, /router\.post\(\s*"\/admission-applications\/:id\/convert-to-student",\s*requirePermission\("admissions\.manage"\)/);
});

test("every workflow write route declares a permission guard before its handler", async () => {
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  const lines = workflows.split(/\r?\n/);
  const writeRoutes = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/router\.(?:post|patch|put|delete)\(/.test(lines[index])) continue;
    const declaration = lines.slice(index, index + 7).join(" ");
    writeRoutes.push(declaration);
    assert.match(declaration, /requirePermission\(/, `unguarded write route at line ${index + 1}`);
  }
  assert.ok(writeRoutes.length > 20, "expected to inspect workflow mutation routes");
});

test("workflow audit insert failures produce a sanitized reconciliation signal", async () => {
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  assert.match(workflows, /import \{ logError \} from "\.\.\/\.\.\/utils\/logger\.js"/);
  assert.match(workflows, /Workflow audit insert failed after the business write/);
  assert.match(workflows, /actionCode,\s*moduleCode: "WORKFLOW",\s*entityType,\s*entityId,\s*requestId: requestId\(req\)/);
  assert.doesNotMatch(workflows, /logError\([^\n]*error\.message/);
});

test("staff acceptance and decline use the atomic status-and-audit RPC", async () => {
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  const permissions = await readFile(new URL("../../../supabase/migrations/202609180001_workflow_permissions.sql", import.meta.url), "utf8");
  const roleWorkspace = await readFile(new URL("../../../supabase/migrations/202609210029_staff_role_workspaces.sql", import.meta.url), "utf8");
  assert.match(workflows, /router\.post\("\/admission-acceptances\/:id\/accept",\s*requirePermission\("admissions\.accept"\),\s*async[\s\S]*?rpc\("transition_admission_acceptance_atomic"[\s\S]*?p_status: "ACCEPTED"/);
  assert.match(workflows, /router\.post\("\/admission-acceptances\/:id\/decline",\s*requirePermission\("admissions\.accept"\),\s*async[\s\S]*?rpc\("transition_admission_acceptance_atomic"[\s\S]*?p_status: "DECLINED"/);
  assert.doesNotMatch(workflows, /from\("admission_offers"\)\.update\(\{ offer_status: "(?:ACCEPTED|DECLINED)"/);
  assert.match(permissions, /\('admissions\.accept','Record admission acceptance'/);
  assert.match(permissions, /'admissions.accept'[\s\S]*?r\.role_code IN \([\s\S]*?'ADMISSIONS_OFFICER'[\s\S]*?'REGISTRAR'/);
  assert.match(roleWorkspace, /r\.role_code='LECTURER'[\s\S]*?p\.permission_code in \([\s\S]*?'admissions.accept'/);
});



test("registration approvals are read-only through CRUD and use atomic workflow RPC", async () => {
  const source = await readFile(new URL("modules/academic-core/academic-core.routes.ts", backend), "utf8");
  const workflows = await readFile(new URL("modules/workflows/workflow.routes.ts", backend), "utf8");
  const migration = await readFile(new URL("../../../supabase/migrations/20261007290000_student_registration_approval_atomic.sql", import.meta.url), "utf8");
  const row = source.split("\n").find(line => line.includes('entityType:"registration_approvals"'));
  assert.match(row, /allowCreate:false, allowUpdate:false, allowDelete:false/);
  const registrationRow = source.split("\n").find(line => line.includes('entityType:"student_registrations"'));
  assert.match(registrationRow, /allowCreate:false, allowUpdate:false, allowDelete:false/);
  assert.match(workflows, /router\.post\("\/registrations\/:id\/approve", requirePermission\("registration\.approve"\), async[\s\S]*?rpc\("approve_student_registration_atomic"/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /INSERT INTO public.audit_logs/);
});
