import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("authentication middleware safely heals a unique email linkage", () => {
  const source = read("apps/backend/src/middleware/auth.ts");
  assert.match(source, /!applicationUser && authUser\.email && authUser\.email_confirmed_at/);
  assert.match(source, /escapeIlikeLiteral\(authUser\.email\)/);
  assert.match(source, /\.ilike\("email", emailPattern\)/);
  assert.match(source, /emailMatches\?\.length === 1/);
  assert.match(source, /candidate\.auth_user_id && candidate\.auth_user_id !== authUser\.id/);
  assert.match(source, /\.is\("auth_user_id", null\)/);
  assert.match(source, /update\(\{ auth_user_id: authUser\.id/);
  assert.doesNotMatch(source, /auth\.admin\.createUser/);
});

test("student portal reconciliation escapes email lookup patterns and refuses to replace existing student ownership", () => {
  const source = read("apps/backend/src/services/student-portal-link.service.ts");
  assert.match(source, /\.ilike\("email", escapeIlikeLiteral\(email\)\)/);
  assert.match(source, /student\.user_id && String\(student\.user_id\) !== String\(account\.id\)/);
  assert.match(source, /Student is already linked to a different IDMC account/);
});

test("login and admissions email lookups escape user supplied ILIKE patterns", () => {
  const login = read("apps/backend/src/modules/auth/services/auth.service.ts");
  const admissions = read("apps/backend/src/modules/admissions/admissions.routes.ts");
  assert.match(login, /\.ilike\("email", escapeIlikeLiteral\(value\)\)/);
  assert.match(login, /\.ilike\("username", escapeIlikeLiteral\(value\)\)/);
  assert.match(admissions, /\.ilike\("email", escapeIlikeLiteral\(verifiedEmail\)\)/);
  assert.match(admissions, /\.ilike\("email", escapeIlikeLiteral\(email\)\)/);
});

test("account authentication does not create or grant a super administrator identity", () => {
  const source = read("apps/backend/src/middleware/auth.ts");
  assert.match(source, /select\([\s\S]*auth_user_id[\s\S]*\)[\s\S]*\.eq\("auth_user_id", authUser\.id\)/);
  assert.match(source, /\.is\("auth_user_id", null\)/);
  assert.doesNotMatch(source, /auth\.admin\.createUser|role_permissions|SUPER_ADMIN/);
});
