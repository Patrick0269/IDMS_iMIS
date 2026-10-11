import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const project = path.resolve(import.meta.dirname, "../../..");
const source = await readFile(path.join(project, "apps/frontend/assets/js/auth.js"), "utf8");

function createAuth(fetchImpl) {
  const values = new Map([["idmc_session", JSON.stringify({ access_token: "access", refresh_token: "refresh" })]]);
  const sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const window = {
    IDMC_CONFIG: { API_BASE_URL: "https://example.test/api/v1", SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "public" },
    location: { pathname: "/student-first-password.html", replace() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
    clearTimeout,
  };
  vm.runInNewContext(source, { window, sessionStorage, fetch: fetchImpl, AbortController, console, setTimeout, clearTimeout });
  return { auth: window.IDMCAuth, values };
}

test("current-account response body timeout ends authentication validation", async () => {
  const hangingResponse = { ok: true, status: 200, text: () => new Promise(() => {}), body: { cancel: async () => undefined } };
  const { auth } = createAuth(async () => hangingResponse);
  await assert.rejects(auth.getCurrentUser(), /response timed out after 12 seconds/);
});

test("session refresh response body timeout clears the stale session", async () => {
  const hangingResponse = { ok: true, status: 200, text: () => new Promise(() => {}), body: { cancel: async () => undefined } };
  const { auth, values } = createAuth(async () => hangingResponse);
  assert.equal(await auth.refreshSession(), null);
  assert.equal(values.has("idmc_session"), false);
});
