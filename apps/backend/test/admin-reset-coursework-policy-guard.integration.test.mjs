import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../../../supabase/migrations/20261011220000_admin_reset_coursework_policy_guard.sql", import.meta.url),
  "utf8",
);

const fixture = `
CREATE TABLE public.idmc_cw_policy(id integer PRIMARY KEY, label text NOT NULL);
CREATE TABLE public.course_result_policies(id integer PRIMARY KEY, status text NOT NULL);
CREATE OR REPLACE FUNCTION public.idmc_cw_role(actor uuid, codes text[])
RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.idmc_cw_policy_guard()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'This programme policy is permanently locked'; END $$;
CREATE OR REPLACE FUNCTION public.idmc_cw_legacy_policy_guard()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status='LOCKED' THEN RAISE EXCEPTION 'Locked examination policy cannot be changed'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER idmc_cw_policy_guard BEFORE UPDATE OR DELETE ON public.idmc_cw_policy
FOR EACH ROW EXECUTE FUNCTION public.idmc_cw_policy_guard();
CREATE TRIGGER idmc_cw_legacy_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.course_result_policies
FOR EACH ROW EXECUTE FUNCTION public.idmc_cw_legacy_policy_guard();
INSERT INTO public.idmc_cw_policy VALUES (1, 'locked');
INSERT INTO public.course_result_policies VALUES (1, 'LOCKED');
`;

async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(migration);
  return db;
}

test("ordinary deletes of locked policies remain prohibited", async () => {
  const db = await database();
  try {
    await assert.rejects(() => db.exec("DELETE FROM public.idmc_cw_policy WHERE id=1"), /permanently locked/);
    await assert.rejects(() => db.exec("DELETE FROM public.course_result_policies WHERE id=1"), /Locked examination policy/);
    const counts = await db.query(`
      SELECT (SELECT count(*)::int FROM public.idmc_cw_policy) AS programme,
             (SELECT count(*)::int FROM public.course_result_policies) AS legacy
    `);
    assert.deepEqual(counts.rows[0], { programme: 1, legacy: 1 });
  } finally {
    await db.close();
  }
});

test("transaction-scoped admin reset can clear locked policies", async () => {
  const db = await database();
  try {
    await db.exec(`
      BEGIN;
      SELECT set_config('idmc.admin_data_reset', 'on', true);
      DELETE FROM public.course_result_policies;
      DELETE FROM public.idmc_cw_policy;
      COMMIT;
    `);
    const counts = await db.query(`
      SELECT (SELECT count(*)::int FROM public.idmc_cw_policy) AS programme,
             (SELECT count(*)::int FROM public.course_result_policies) AS legacy
    `);
    assert.deepEqual(counts.rows[0], { programme: 0, legacy: 0 });
  } finally {
    await db.close();
  }
});

test("the production reset marker is scoped to the audited reset RPC", async () => {
  const resetMigration = await readFile(
    new URL("../../../supabase/migrations/20261004230000_admin_data_reset_guard_bypass_and_fk_order.sql", import.meta.url),
    "utf8",
  );
  assert.match(resetMigration, /CREATE FUNCTION public\.admin_data_reset_execute[\s\S]*?set_config\('idmc\.admin_data_reset','on',true\)[\s\S]*?admin_data_reset_execute_base/);
  assert.match(resetMigration, /REVOKE ALL ON FUNCTION public\.admin_data_reset_execute\(text\[\],text,uuid\) FROM PUBLIC,anon,authenticated/);
  assert.match(resetMigration, /GRANT EXECUTE ON FUNCTION public\.admin_data_reset_execute\(text\[\],text,uuid\) TO service_role/);
});
