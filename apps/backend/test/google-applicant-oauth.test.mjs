import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  NODE_ENV: "test",
  AUTH_PROVIDER: "postgres",
  POSTGREST_URL: "http://127.0.0.1:3001",
  POSTGREST_SERVICE_ROLE_KEY: "test-only-service-role",
  LOCAL_AUTH_JWT_SECRET: "test-local-auth-secret-that-is-long-enough",
  JWT_SECRET: "test-general-jwt-secret-that-is-long-enough",
  SMTP_HOST: "localhost",
  SMTP_USER: "test@example.com",
  SMTP_PASSWORD: "test-only",
  SMTP_FROM_EMAIL: "test@example.com",
  FRONTEND_URL: "http://127.0.0.1:5500",
  GOOGLE_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://127.0.0.1:4000/api/v1/auth/google/applicant/callback",
});

const { googleApplicantStart, googleApplicantCallback } = await import("../dist/modules/auth/controllers/auth.controller.js");

test("Google applicant start uses the configured callback and issues short-lived CSRF cookies", () => {
  const cookies = [];
  let location = "";
  const response = {
    cookie(name, value, options) { cookies.push({ name, value, options }); },
    redirect(url) { location = url; },
  };
  googleApplicantStart({}, response);
  const authorize = new URL(location);
  assert.equal(authorize.origin, "https://accounts.google.com");
  assert.equal(authorize.searchParams.get("redirect_uri"), process.env.GOOGLE_OAUTH_REDIRECT_URI);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("nonce")?.length > 20, true);
  assert.equal(authorize.searchParams.get("state")?.length > 20, true);
  assert.deepEqual(cookies.map(cookie => cookie.name).sort(), ["idmc_google_nonce", "idmc_google_state"]);
  assert.ok(cookies.every(cookie => cookie.options.httpOnly && cookie.options.sameSite === "lax" && cookie.options.maxAge <= 600000));
});

test("Google applicant callback rejects a mismatched OAuth state before exchanging any code", async () => {
  const cookies = [];
  let location = "";
  const response = {
    cookie(name, value, options) { cookies.push({ name, value, options }); },
    redirect(url) { location = url; },
  };
  await googleApplicantCallback({
    headers: { cookie: "idmc_google_state=expected; idmc_google_nonce=nonce" },
    query: { state: "attacker-state", code: "must-not-be-exchanged" },
  }, response);
  assert.equal(new URL(location).searchParams.get("google_error"), "invalid");
  assert.ok(cookies.every(cookie => cookie.options.maxAge === 0));
});
