import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STAFF_UPLOAD_BYTES, validateStaffUpload } from "../dist/utils/staff-upload-validation.js";

const encode = bytes => Buffer.from(bytes).toString("base64");

test("staff upload validation requires a file signature and a MIME/extension match", () => {
  const pdf = encode(Buffer.from("%PDF-1.7 content"));
  assert.equal(validateStaffUpload({ fileName: "record.pdf", mimeType: "application/pdf", contentBase64: pdf }).mimeType, "application/pdf");
  assert.throws(() => validateStaffUpload({ fileName: "record.pdf", mimeType: "image/png", contentBase64: pdf }), /does not match/);
  assert.throws(() => validateStaffUpload({ fileName: "record.pdf", mimeType: "application/pdf", contentBase64: encode(Buffer.from("not a PDF")) }), /contents do not match/);
});

test("staff upload rejects malformed base64, unsupported passport formats and oversize files", () => {
  assert.throws(() => validateStaffUpload({ fileName: "x.png", contentBase64: "%%%" }), /valid base64/);
  assert.throws(() => validateStaffUpload({ fileName: "passport.pdf", documentType: "PASSPORT", contentBase64: encode(Buffer.from("%PDF-1.7")) }), /Passport photo/);
  assert.throws(() => validateStaffUpload({ fileName: "large.pdf", contentBase64: encode(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024)])) }), /below 5 MB/);
  assert.equal(MAX_STAFF_UPLOAD_BYTES, 7 * 1024 * 1024);
});

test("staff register and file upload routes validate signatures and bound aggregate request size", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/modules/operational-improvements/operational.routes.ts", import.meta.url), "utf8");
  assert.match(source, /validateStaffUpload\(f\)/);
  assert.match(source, /MAX_STAFF_UPLOAD_BYTES/);
});
