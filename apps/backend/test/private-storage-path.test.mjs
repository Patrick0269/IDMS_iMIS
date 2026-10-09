import assert from "node:assert/strict";
import test from "node:test";
import { privateStorageObjectPath } from "../dist/utils/private-storage-path.js";

const supabase = "https://idmc-test.supabase.co";

test("private storage path accepts safe object paths and converts same-project legacy URLs", () => {
  assert.equal(privateStorageObjectPath("students/student-1/docs/cert.pdf", supabase), "students/student-1/docs/cert.pdf");
  assert.equal(privateStorageObjectPath("https://idmc-test.supabase.co/storage/v1/object/public/idmc-private-documents/students/s-1/cert%20one.pdf?token=old", supabase), "students/s-1/cert one.pdf");
  assert.equal(privateStorageObjectPath("https://idmc-test.supabase.co/storage/v1/object/sign/idmc-private-documents/students/s-1/cert.pdf?token=old", supabase), "students/s-1/cert.pdf");
});

test("private storage path rejects external hosts, other buckets, and path traversal", () => {
  for (const path of [
    "https://attacker.example/file.pdf",
    "https://idmc-test.supabase.co/storage/v1/object/public/public-assets/file.pdf",
    "https://idmc-test.supabase.co/storage/v1/object/public/idmc-private-documents/students/%2e%2e/secret.pdf",
    "students/../secret.pdf",
    "//attacker.example/file.pdf",
    "students/%2e%2e/secret.pdf",
  ]) assert.equal(privateStorageObjectPath(path, supabase), null, path);
});

test("student storage paths remain scoped to the authenticated student's folder", () => {
  assert.equal(privateStorageObjectPath("students/student-1/docs/cert.pdf", supabase, "students/student-1/"), "students/student-1/docs/cert.pdf");
  assert.equal(privateStorageObjectPath("students/student-2/docs/cert.pdf", supabase, "students/student-1/"), null);
});

test("private storage path accepts one of several trusted entity prefixes", () => {
  assert.equal(privateStorageObjectPath("admissions/app-1/file.pdf", supabase, ["admissions/app-1/", "applicants/applicant-1/app-1/"]), "admissions/app-1/file.pdf");
  assert.equal(privateStorageObjectPath("applicants/applicant-1/app-1/file.pdf", supabase, ["admissions/app-1/", "applicants/applicant-1/app-1/"]), "applicants/applicant-1/app-1/file.pdf");
  assert.equal(privateStorageObjectPath("applicants/applicant-2/app-1/file.pdf", supabase, ["admissions/app-1/", "applicants/applicant-1/app-1/"]), null);
});

test("student document downloads sign validated storage paths instead of returning arbitrary URLs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/modules/student-management/students/student-self-service.routes.ts", import.meta.url), "utf8");
  assert.match(source, /privateStorageObjectPath\(result\.data\.file_url \|\| result\.data\.file_path, env\.SUPABASE_URL, `students\/\$\{student\.id\}\/`\)/);
  assert.doesNotMatch(source, /if\s*\(\s*\^https\?:.*return\s*\{\s*url\s*:\s*path/);
  const admissions = await readFile(new URL("../src/modules/admissions/admissions.routes.ts", import.meta.url), "utf8");
  const finance = await readFile(new URL("../src/modules/finance/routes/finance-workflow.routes.ts", import.meta.url), "utf8");
  assert.match(admissions, /privateStorageObjectPath\(document\.data\.file_url, env\.SUPABASE_URL, prefixes\)/);
  assert.match(finance, /privateStorageObjectPath\(request\.data\.receipt_file_path, env\.SUPABASE_URL, `finance\/receipts\/\$\{request\.data\.student_id\}\/`\)/);
});
