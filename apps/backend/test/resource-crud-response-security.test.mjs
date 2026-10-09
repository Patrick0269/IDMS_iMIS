import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectCrudResponse } from "../dist/utils/resourceCrud.js";

test("generic CRUD responses project rows onto their declared field allowlist", () => {
  const row = { id: "app-1", first_name: "Amina", email: "a@example.edu", auth_user_id: "auth-secret", bank_account_number: "private", internal_review_token: "hidden" };
  assert.deepEqual(projectCrudResponse(row, ["id", "first_name", "email"]), { id: "app-1", first_name: "Amina", email: "a@example.edu" });
});

test("generic CRUD detail and write responses do not expose unrestricted database rows", async () => {
  const source = await readFile(new URL("../src/utils/resourceCrud.ts", import.meta.url), "utf8");
  assert.match(source, /\.select\(fields\.join\(","\)\)/);
  assert.match(source, /projectCrudResponse\(data as unknown as Record<string, unknown>,\s*fields\)/);
  assert.match(source, /projectCrudResponse\(data,\s*responseFields\(config\)\)/);
});
