import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const scriptUrl = new URL("../../frontend/assets/js/applicant-access.js", import.meta.url);
const source = await readFile(scriptUrl, "utf8");

function runConfirmation(hash, profile = { roles: [{ id: "applicant-role", roleCode: "APPLICANT" }] }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: true, className: "", textContent: "", handlers: {}, elements: { email: { value: "" } }, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return elements.get(id);
  };
  const calls = { session: null, role: null, redirect: null, cleared: false, cleanedUrl: null };
  const location = { search: "", hash, pathname: "/applicant-access.html", replace(url) { calls.redirect = url; } };
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
    fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
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

test("verification callback does not grant access if the returned identity lacks the applicant role", async () => {
  const { calls, elements } = runConfirmation("#access_token=verified-token&type=signup", { roles: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.redirect, null);
  assert.equal(calls.cleared, true);
  assert.match(elements.get("applicantMessage").textContent, /applicant portal role was not found/i);
});
