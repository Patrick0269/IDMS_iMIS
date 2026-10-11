import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "../../..");
const script = await fs.readFile(path.join(root, "apps/frontend/assets/js/student-first-password.js"), "utf8");

class Element {
  constructor(value = "") { this.value = value; this.listeners = {}; this.hidden = false; this.disabled = false; this.textContent = ""; this.className = ""; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  reportValidity() { return true; }
}

test("first-time student can verify session, submit a new password and continue to Student Portal", async () => {
  const elements = new Map([
    ["form", new Element()], ["message", new Element()], ["save", new Element()],
    ["progress", new Element()], ["progressText", new Element()], ["logout", new Element()],
    ["retryValidation", new Element()],
    ["current", new Element("NS1234/2020/2000")], ["next", new Element("SafePassword123")],
    ["confirm", new Element("SafePassword123")],
  ]);
  const calls = [];
  const window = { location: { replace: url => calls.push(["redirect", url]) } };
  const document = { getElementById: id => elements.get(id) };
  const context = {
    document, window,
    IDMCAuth: {
      requireAuth: async () => { throw new Error("The password page must not silently refresh and retry authentication"); },
      refreshSession: async () => ({ access_token: "refreshed" }),
      getCurrentUser: async () => {
        calls.push(["auth"]);
        return { mustChangePassword: calls.filter(call => call[0] === "auth").length === 1 };
      },
      redirectAfterLogin: () => { throw new Error("unexpected redirect"); },
      logout: () => calls.push(["logout"]),
    },
    IDMCAPI: { post: async (route, payload) => { calls.push(["post", route, payload]); return { success: true }; } },
  };

  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("progress").hidden, true, "account verification completes and reveals the form");
  assert.equal(elements.get("save").disabled, false);

  await elements.get("form").listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls.map(call => call[0]), ["auth", "post", "auth", "redirect"]);
  assert.equal(calls[1][1], "/auth/change-password");
  assert.equal(calls[1][2].currentPassword, "NS1234/2020/2000");
  assert.deepEqual(calls[3], ["redirect", "student-portal.html"]);
});

test("failed account validation ends the form loader and explains how to retry", async () => {
  const elements = new Map(["form", "message", "save", "progress", "progressText", "logout", "retryValidation", "current", "next", "confirm"].map(id => [id, new Element()]));
  const context = {
    document: { getElementById: id => elements.get(id) },
    window: { location: { replace() {} } },
    IDMCAuth: {
      requireAuth: async () => { throw new Error("Must not use recursive authentication"); },
      getCurrentUser: async () => { throw new Error("Session was rejected by /auth/me"); },
      logout() {},
    },
    IDMCAPI: { post: async () => { throw new Error("Must not submit before validation"); } },
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("progress").hidden, true);
  assert.equal(elements.get("save").disabled, true);
  assert.match(elements.get("message").textContent, /Session was rejected by \/auth\/me/);
  assert.equal(elements.get("logout").textContent, "Rudi kwenye login");
  assert.equal(elements.get("retryValidation").hidden, false);
});
