import test from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../dist/middleware/rateLimit.js";
import { normalizeRequestId, requestContext } from "../dist/middleware/requestContext.js";

test("request ID preserves safe IDs and replaces unsafe input", () => {
  assert.equal(normalizeRequestId("portal-request-123"), "portal-request-123");
  assert.notEqual(normalizeRequestId("unsafe id with spaces"), "unsafe id with spaces");
  assert.match(normalizeRequestId(undefined), /^[0-9a-f-]{36}$/);
});

test("request context exposes only normalized request IDs to handlers and response headers", () => {
  const req = {
    headers: { "x-request-id": "bad id\nforged" },
    header(name) { return this.headers[name.toLowerCase()]; },
    method: "GET",
    originalUrl: "/health",
  };
  const headers = {};
  const res = { setHeader(name, value) { headers[name] = value; }, on() {} };
  let nextCalled = false;

  requestContext(req, res, () => { nextCalled = true; });

  assert.notEqual(req.requestId, req.headers["x-request-id"]);
  assert.match(req.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(headers["X-Request-Id"], req.requestId);
  assert.equal(nextCalled, true);
});

test("rate limiter returns 429 after configured attempts", () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 2, name: `test-${Date.now()}` });
  const req = { ip: "192.0.2.10", socket: {} };
  let statusCode = 200, payload, nextCount = 0;
  const res = { setHeader() {}, status(code) { statusCode = code; return this; }, json(body) { payload = body; return this; } };
  middleware(req, res, () => { nextCount += 1; });
  middleware(req, res, () => { nextCount += 1; });
  middleware(req, res, () => { nextCount += 1; });
  assert.equal(nextCount, 2);
  assert.equal(statusCode, 429);
  assert.equal(payload.success, false);
});
