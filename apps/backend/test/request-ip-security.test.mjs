import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getClientIp } from "../dist/utils/request.js";

test("audit client IP uses Express/socket address and ignores forged forwarded headers", () => {
  assert.equal(getClientIp({ ip: "203.0.113.8", socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "198.51.100.77" } }), "203.0.113.8");
  assert.equal(getClientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "198.51.100.77" } }), "127.0.0.1");
  assert.equal(getClientIp({ headers: { "x-forwarded-for": "198.51.100.77" } }), null);
});

test("user and role audit controllers use the trusted client IP helper", async () => {
  for (const file of ["../dist/modules/users/controllers/users.controller.js", "../dist/modules/users/controllers/roles.controller.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /getClientIp as getIpAddress/);
    assert.doesNotMatch(source, /x-forwarded-for/i);
  }
});
