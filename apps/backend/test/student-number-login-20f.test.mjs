import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("student authentication has a dedicated endpoint", () => {
  const routes = read("apps/backend/src/modules/auth/routes/auth.routes.ts");
  assert.match(routes, /router\.post\("\/student-login"/);
  assert.match(routes, /password-reset/);
  assert.match(routes, /password-setup-complete/);
  assert.match(routes, /router\.post\("\/change-password"/);
  const authService = read("apps/backend/src/modules/auth/services/auth.service.ts");
  const genericResolver = authService.slice(0, authService.indexOf("export async function login"));
  assert.doesNotMatch(genericResolver, /resolveStudentLoginEmail\(/);
  const controller = read("apps/backend/src/modules/auth/controllers/auth.controller.ts");
  assert.doesNotMatch(controller, /logError\(`(?:Student )?login failed.*\$\{(?:identifier|studentNumber)\}/i);
});

test("legacy first-login metadata no longer blocks student portal access", () => {
  const middleware = read("apps/backend/src/middleware/auth.ts");
  assert.match(middleware, /mustChangePassword:\s*false/);
  assert.doesNotMatch(middleware, /PASSWORD_CHANGE_REQUIRED/);
  assert.doesNotMatch(middleware, /app_metadata\?\.idmc_student_first_login/);
});

test("student number has an exact institutional format", () => {
  const service = read("apps/backend/src/modules/auth/services/student-login.service.ts");
  assert.match(service, /\^IDMC\\\/\\d\{4\}\\\/\\d\{5\}\$/);
  assert.doesNotMatch(service, /Application Number ->/);
});

test("linked Supabase auth identity is authoritative", () => {
  const service = read("apps/backend/src/modules/auth/services/student-login.service.ts");
  assert.match(service, /auth\.admin\.getUserById/);
  assert.match(service, /select\("id,auth_user_id,status"\)/);
  assert.match(service, /auth\.admin\.getUserById/);
  assert.doesNotMatch(service, /password\.trim\(\)\.toUpperCase\(\) === studentNumber/);
  assert.doesNotMatch(service, /linkStudentPortalAccount/);
});

test("student number is a first-login temporary password only; recovery verifies institutional records", () => {
  const service = read("apps/backend/src/modules/auth/services/student-login.service.ts");
  const linking = read("apps/backend/src/services/student-portal-link.service.ts");
  assert.match(service, /initialiseStudentFirstLogin/);
  assert.match(service, /needsStudentPasswordChange/);
  assert.match(service, /idmc_student_initial_number/);
  assert.doesNotMatch(linking, /password:\s*String\(student\.student_number\)/);
  assert.match(service, /generateLink\(\{[\s\S]*type: "recovery"/);
  assert.match(service, /sendAccountPasswordRecoveryEmail/);
  assert.match(service, /academic_qualifications/);
  assert.match(service, /staff_category/);
  assert.match(service, /normalizePhone/);
  assert.match(service, /endsWith\("@students\.idmc\.local"\)/);
  assert.doesNotMatch(service, /from\("student_registrations"\)/);
  assert.doesNotMatch(service, /activated_at/);
});

test("one login form recognizes student identifiers and redirects by verified account role", () => {
  const html = read("apps/frontend/login.html");
  const auth = read("apps/frontend/assets/js/auth.js");
  const passwordPage = read("apps/frontend/set-password.html");
  const studentSecurity = read("apps/frontend/student-security.html");
  const staffSecurity = read("apps/frontend/staff-self-service.html");
  const recoveryPage = read("apps/frontend/forgot-password.html");
  assert.match(html, /Email, username or Student Number/);
  assert.doesNotMatch(html, /id="studentAccess"|id="staffAccess"/);
  assert.match(html, /studentNumberPattern\.test\(username/);
  assert.match(html, /IDMCAuth\.getLandingPage\(\)/);
  assert.match(html, /IDMCAuth\.studentLogin/);
  assert.match(auth, /requestVerifiedPasswordReset/);
  assert.match(html, /forgot-password\.html/);
  assert.match(recoveryPage, /registrationNumber/);
  assert.match(recoveryPage, /formFourYear/);
  assert.match(recoveryPage, /lecturerPhone/);
  assert.match(recoveryPage, /lecturerEmail/);
  assert.match(passwordPage, /password-setup-complete/);
  assert.match(passwordPage, /password\.length < 12/);
  assert.match(studentSecurity, /name="currentPassword"/);
  assert.match(staffSecurity, /name="currentPassword"/);
  assert.doesNotMatch(html, /Registration No\., Application No\. or Email/);
});

test("student login only authenticates the existing linked student account", () => {
  const service = read("apps/backend/src/modules/auth/services/student-login.service.ts");
  assert.match(service, /student\.user_id\)/);
  assert.match(service, /\.eq\("id", student\.user_id\)/);
  assert.match(service, /auth\.admin\.getUserById\(String\(user\.auth_user_id\)\)/);
  assert.doesNotMatch(service, /auth\.admin\.createUser|\.from\("user_roles"\)\.insert/);
});


test("student login reads the current students schema and does not require a legacy registration_number column", () => {
  const service = read("apps/backend/src/modules/auth/services/student-login.service.ts");
  assert.match(service, /\.or\(/);
  assert.match(service, /student_number\.ilike/);
  assert.doesNotMatch(service, /student\.registration_number/);
});
