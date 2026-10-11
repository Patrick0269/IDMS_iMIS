import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../../../supabase/migrations/20261012000100_admin_reset_statement_timeout.sql", import.meta.url),
  "utf8",
);

test("the reset RPC alone receives a 60 second statement timeout", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE FUNCTION public.admin_data_reset_execute(text[], text, uuid)
      RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.other_rpc()
      RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    await db.exec(migration);

    const reset = await db.query(`
      SELECT proconfig FROM pg_proc
       WHERE oid='public.admin_data_reset_execute(text[],text,uuid)'::regprocedure
    `);
    const other = await db.query(`
      SELECT proconfig FROM pg_proc WHERE oid='public.other_rpc()'::regprocedure
    `);
    assert.deepEqual(reset.rows[0].proconfig, ["statement_timeout=60s"]);
    assert.equal(other.rows[0].proconfig, null);
  } finally {
    await db.close();
  }
});
