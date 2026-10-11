import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const apiSource = await readFile(new URL("../../frontend/assets/js/api.js", import.meta.url), "utf8");

function loadApi(online = true) {
  const window = { IDMC_DISABLE_GLOBAL_PROGRESS: true, setTimeout, clearTimeout };
  const context = {
    window,
    document: { currentScript: null, head: { appendChild() {} }, createElement() { return {}; } },
    location: { href: "https://idmc.example.test/dashboard.html" },
    navigator: { onLine: online },
    URL,
    Headers,
    FormData: class FormData {},
    Blob,
    AbortController,
    fetch: async () => { throw new TypeError("Failed to fetch"); },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(apiSource, context, { filename: "api.js" });
  return window.IDMCAPI;
}

test("network errors explain offline, timeout and temporary service failures without backend details", () => {
  const api = loadApi(true);
  const offline = loadApi(false);
  const messages = [
    api.toUserMessage({ status: 0, code: "NETWORK_UNAVAILABLE", message: "Unable to connect to IDMC backend. Port 4000" }),
    offline.toUserMessage({ status: 0, message: "Failed to fetch" }),
    api.toUserMessage({ status: 0, code: "REQUEST_TIMEOUT" }),
    api.toUserMessage({ status: 503, requestId: "safe-reference", message: "Database connection refused" })
  ];

  assert.match(messages[0], /couldn't reach the service/i);
  assert.match(messages[1], /offline|internet connection/i);
  assert.match(messages[2], /longer than expected|connection/i);
  assert.match(messages[3], /try again/i);
  assert.match(messages[3], /safe-reference/);
  for (const message of messages) assert.doesNotMatch(message, /backend|port 4000|database connection refused/i);
});
