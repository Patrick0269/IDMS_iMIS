import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const project = resolve(import.meta.dirname, "../../..");
const read = relative => readFileSync(resolve(project, relative), "utf8");

test("frontend API config derives its target at runtime", () => {
  const config = read("apps/frontend/assets/js/config.js");
  assert.doesNotMatch(config, /API_BASE_URL\s*:\s*["']http:\/\//);
  assert.match(config, /__IDMC_RUNTIME_CONFIG__/);
  assert.match(config, /window\.location\.origin/);
});

test("runtime API defaults to port 4000 locally and same-origin in deployment", () => {
  const source = read("apps/frontend/assets/js/config.js");
  const execute = location => {
    const window = { location, IDMC_CONFIG: undefined, __IDMC_RUNTIME_CONFIG__: undefined };
    runInNewContext(source, { window, document: { querySelector() { return null; } }, Set });
    return window.IDMC_CONFIG.API_BASE_URL;
  };
  assert.equal(execute({ protocol: "http:", hostname: "127.0.0.1", port: "5500", origin: "http://127.0.0.1:5500" }), "http://127.0.0.1:4000/api/v1");
  assert.equal(execute({ protocol: "https:", hostname: "imis.example.ac.tz", port: "", origin: "https://imis.example.ac.tz" }), "https://imis.example.ac.tz/api/v1");
});

test("homepage root serves the institutional index and staff login stays explicit", () => {
  const login = read("apps/frontend/login.html");
  const frontendServer = read("apps/frontend/server.mjs");
  const starter = read("Start-IDMC.ps1");

  assert.match(login, /<base href="\/">/);
  assert.match(login, /id="loginForm"/);
  assert.match(frontendServer, /pathname === "\/"\) return join\(root, "index\.html"\)/);
  assert.match(frontendServer, /pathname === "\/login"/);
  assert.match(frontendServer, /pathname === "\/login\/"/);
  assert.match(starter, /node server\.mjs/);
  assert.match(starter, /siteHeroTitle/);
  assert.match(starter, /applicant-access\.html/);
  assert.doesNotMatch(starter, /npx --yes live-server/);
});

test("applicant forms use the shared API configuration", () => {
  assert.match(read("apps/frontend/assets/js/applicant-live-forms.js"), /IDMC_CONFIG\?\.API_BASE_URL/);
});

test("distribution has an environment template and ignores real environments", () => {
  assert.equal(existsSync(resolve(project, "apps/backend/.env.example")), true);
  assert.match(read(".gitignore"), /\.env/);
});

test("student ownership, scoped aliases and callback contracts are mounted", () => {
  const routes = read("apps/backend/src/routes/index.ts");
  assert.match(routes, /scopedAliasPrefix\("\/procurement"\)/);
  assert.match(routes, /router\.use\("\/self-service"/);
  assert.match(routes, /router\.use\("\/payment-provider"/);
  assert.match(read("apps/backend/src/modules/student-management/students/student-self-service.routes.ts"), /requirePermission\("students\.self\.view"\)/);
});

test("self-service, staff-workspace and payment-provider failures use the sanitized API error handler", () => {
  const actions = read("apps/backend/src/modules/self-service-actions/self-service-actions.routes.ts");
  const callback = read("apps/backend/src/modules/self-service-actions/payment-provider.routes.ts");
  const staffController = read("apps/backend/src/modules/staff-workspace/staff-workspace.controller.ts");
  const staffService = read("apps/backend/src/modules/staff-workspace/staff-workspace.service.ts");
  const studentEngagement = read("apps/backend/src/modules/student-engagement/student-engagement.routes.ts");
  const staffOperations = read("apps/backend/src/modules/staff-operations/staff-operations.routes.ts");
  assert.match(actions, /catch \(error\) \{ next\(error\); \}/);
  assert.match(actions, /import \{ httpError \} from "\.\.\/\.\.\/utils\/httpError\.js"/);
  assert.match(actions, /httpError\("Course offering is required\.", 400\)/);
  assert.doesNotMatch(actions, /res\.status\(400\)\.json\(\{\s*success:\s*false,\s*message:\s*error/);
  assert.match(callback, /catch\(error\)\{next\(error\);\}/);
  assert.doesNotMatch(callback, /res\.status\(400\).*error\.message/);
  assert.match(staffController, /catch \(error\) \{ return next\(error\); \}/);
  assert.doesNotMatch(staffController, /res\.status\(400\).*error\.message/);
  assert.match(staffService, /httpError\("Assessment, student and a non-negative mark are required\.", 400\)/);
  assert.doesNotMatch(staffService, /error\.message/);
  assert.match(studentEngagement, /catch\(error\)\{next\(error\)\}/);
  assert.match(studentEngagement, /httpError\("Payment, positive amount with at most two decimal places, and reason are required\.",400\)/);
  assert.doesNotMatch(studentEngagement, /res\.status\(400\)\.json\(\{success:false,message:e instanceof Error\?e\.message/);
  assert.match(staffOperations, /catch \(error\) \{ next\(error\); \}/);
  assert.match(staffOperations, /could not be loaded within the staff institution scope/);
  assert.doesNotMatch(staffOperations, /error\.message/);
});
