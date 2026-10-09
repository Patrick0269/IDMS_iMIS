import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generic Admissions applicant CRUD cannot accept or infer Auth identity links", async () => {
  const route = await readFile(new URL("../src/modules/admissions/admissions.routes.ts", import.meta.url), "utf8");
  const portal = await readFile(new URL("../src/modules/applicant-self-service/applicant-self-service.routes.ts", import.meta.url), "utf8");
  const crud = await readFile(new URL("../src/utils/resourceCrud.ts", import.meta.url), "utf8");
  const applicantConfig = route.slice(route.indexOf('entityType: "applicants"'), route.indexOf('}, "/applicants")'));
  assert.doesNotMatch(applicantConfig, /authUserId|auth_user_id/);
  assert.doesNotMatch(crud, /payload\.auth_user_id\s*=\s*req\.user\.authUserId/);
  assert.match(portal, /auth_user_id:\s*req\.user!\.authUserId/);
  assert.match(portal, /emailMatchesVerifiedAuth\(requestedEmail, verifiedEmail\)/);
});
