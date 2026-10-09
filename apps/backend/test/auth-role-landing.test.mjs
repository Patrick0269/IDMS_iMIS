import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const project = resolve(import.meta.dirname, "../../..");
const authSource = readFileSync(resolve(project, "apps/frontend/assets/js/auth.js"), "utf8");

function authHarness() {
  const values = new Map();
  const location = { pathname: "/login.html", replace(value) { this.replaced = value; } };
  const window = { IDMC_CONFIG: { API_BASE_URL: "https://api.example.test" }, location, setTimeout, clearTimeout };
  const sessionStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  runInNewContext(authSource, { window, document: {}, sessionStorage, fetch: async () => { throw new Error("unexpected network request"); }, console, AbortController, URL });
  return window.IDMCAuth;
}

test("role landing prioritizes Admin and sends roleless accounts to access denied", () => {
  const auth = authHarness();
  auth.saveUser({ roles: [
    { id: "lecturer", roleCode: "LECTURER", permissions: ["results.submit"] },
    { id: "admin", roleCode: "ADMIN", permissions: ["system.config.manage"] },
  ] });
  assert.equal(auth.getActiveRoleId(), "admin");
  assert.equal(auth.getLandingPage(), "dashboard.html");
  auth.saveUser({ roles: [], permissions: [] });
  assert.equal(auth.getLandingPage(), "access-denied.html");
});

test("a selected role controls landing page and client-side permission checks", () => {
  const auth = authHarness();
  auth.saveUser({ roles: [
    { id: "hod", roleCode: "HOD", permissions: ["results.review"] },
    { id: "lecturer", roleCode: "LECTURER", permissions: ["results.submit"] },
  ], permissions: ["results.review", "results.submit"] });
  auth.setActiveRole("lecturer");
  assert.equal(auth.getLandingPage(), "lecturer-portal.html");
  assert.equal(auth.hasPermission("results.submit"), true);
  assert.equal(auth.hasPermission("results.review"), false);
  assert.throws(() => auth.setActiveRole("not-assigned"), /not assigned/);
});
