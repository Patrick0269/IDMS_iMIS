import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const scriptUrl = new URL("../../frontend/assets/js/applicant-access.js", import.meta.url);
const source = await readFile(scriptUrl, "utf8");

function runConfirmation(hash, profile = { roles: [{ id: "applicant-role", roleCode: "APPLICANT" }] }, search = "", verifyPayload = { success: true, data: { access_token: "verified-token", refresh_token: "refresh-token" } }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: true, className: "", textContent: "", handlers: {}, elements: { email: { value: "" } }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return elements.get(id);
  };
  const calls = { session: null, role: null, redirect: null, cleared: false, cleanedUrl: null, verifyUrl: null, verifyBody: null };
  const location = { search, hash, pathname: "/applicant-access.html", replace(url) { calls.redirect = url; } };
  const context = {
    URLSearchParams,
    URL,
    window: {
      location,
      IDMC_CONFIG: { API_BASE_URL: "/api/v1" },
      IDMCAuth: {
        saveSession(session) { calls.session = session; },
        async getCurrentUser() { return profile; },
        setActiveRole(roleId) { calls.role = roleId; },
        clearSession() { calls.cleared = true; }
      }
    },
    document: { getElementById: element },
    history: { replaceState(_state, _title, url) { calls.cleanedUrl = url; } },
    fetch: async (url, options) => { calls.verifyUrl = url; calls.verifyBody = JSON.parse(options.body); return { ok: true, json: async () => verifyPayload }; },
    FormData: class {},
    console,
    setTimeout
  };
  vm.runInNewContext(source, context, { filename: "applicant-access.js" });
  return { calls, elements };
}

test("verified applicant callback saves the session and routes directly to the applicant portal", async () => {
  const { calls } = runConfirmation("#access_token=verified-token&refresh_token=refresh-token&type=signup&expires_in=3600", {
    roles: [{ id: "applicant-role", roleCode: "APPLICANT" }]
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.session.access_token, "verified-token");
  assert.equal(calls.session.refresh_token, "refresh-token");
  assert.equal(calls.role, "applicant-role");
  assert.equal(calls.redirect, "/applicant-portal.html");
  assert.equal(calls.cleanedUrl, "/applicant-access.html");
  assert.equal(calls.cleared, false);
});

test("Google applicant callback saves the PostgreSQL-issued session and opens the applicant portal", async () => {
  const { calls } = runConfirmation("#access_token=google-access&refresh_token=postgres-refresh&token_type=bearer&type=google&new_applicant=1", {
    roles: [{ id: "applicant-role", roleCode: "APPLICANT" }]
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.session.access_token, "google-access");
  assert.equal(calls.session.refresh_token, "postgres-refresh");
  assert.equal(calls.role, "applicant-role");
  assert.equal(calls.redirect, "/applicant-portal.html");
  assert.equal(calls.cleanedUrl, "/applicant-access.html");
});

test("Google sign-in failures show a safe message and remove the error query", () => {
  const { calls, elements } = runConfirmation("", undefined, "?google_error=account_exists");
  assert.equal(elements.get("applicantMessage").textContent.includes("already uses this email"), true);
  assert.equal(calls.cleanedUrl, "/applicant-access.html");
});

test("verification callback does not grant access if the returned identity lacks the applicant role", async () => {
  const { calls, elements } = runConfirmation("#access_token=verified-token&type=signup", { roles: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.redirect, null);
  assert.equal(calls.cleared, true);
  assert.match(elements.get("applicantMessage").textContent, /applicant portal role was not found/i);
});

test("custom signup token confirmation calls the IDMC backend and strips the one-time token from the address bar", async () => {
  const { calls } = runConfirmation("", { roles: [{ id: "applicant-role", roleCode: "APPLICANT" }] }, "?token_hash=one-time-token&type=signup");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.verifyUrl, "/api/v1/auth/applicant-verification-confirm");
  assert.deepEqual(calls.verifyBody, { token_hash: "one-time-token" });
  assert.equal(calls.cleanedUrl, "/applicant-access.html");
  assert.equal(calls.session.access_token, "verified-token");
  assert.equal(calls.redirect, "/applicant-portal.html");
});
