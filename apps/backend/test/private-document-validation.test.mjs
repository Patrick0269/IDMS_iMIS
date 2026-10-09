import assert from "node:assert/strict";
import test from "node:test";
import { privateDocumentMatchesMime } from "../dist/utils/private-document-validation.js";

const fixtures = [
  ["application/pdf", Buffer.from("%PDF-1.7 body")],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/webp", Buffer.from("RIFFxxxxWEBP")],
];

test("private document uploads require bytes matching the declared MIME type", () => {
  for (const [mime, bytes] of fixtures) assert.equal(privateDocumentMatchesMime(bytes, mime), true, mime);
  assert.equal(privateDocumentMatchesMime(Buffer.from("not a PDF"), "application/pdf"), false);
  assert.equal(privateDocumentMatchesMime(fixtures[0][1], "image/png"), false);
  assert.equal(privateDocumentMatchesMime(Buffer.from("%PDF-"), "application/octet-stream"), false);
  assert.equal(privateDocumentMatchesMime("%PDF-", "application/pdf"), false);
});

test("all private document upload routes apply signature validation before storage", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../src/modules/", import.meta.url);
  const files = [
    "applicant-self-service/applicant-self-service.routes.ts",
    "admissions/admissions.routes.ts",
    "student-management/students/student-self-service.routes.ts",
    "self-service-actions/self-service-actions.routes.ts",
    "student-engagement/student-engagement.routes.ts",
    "finance/routes/finance-workflow.routes.ts",
    "operational-improvements/operational.routes.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    const upload = /storage\.from\(["']idmc-private-documents["']\)\.upload/g;
    let previous = 0, match, uploadCount = 0;
    while ((match = upload.exec(source))) {
      const route = source.slice(previous, match.index);
      assert.match(route, /privateDocumentMatchesMime\(body\s*,\s*mime(?:Type)?\)/, `${file} must check file bytes before storage`);
      previous = upload.lastIndex;
      uploadCount++;
    }
    if (file === "applicant-self-service/applicant-self-service.routes.ts") assert.equal(uploadCount, 2);
  }
});
