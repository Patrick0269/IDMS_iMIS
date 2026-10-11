import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../../../supabase/migrations/20261012000300_admin_reset_cache_fk_dependencies.sql", import.meta.url),
  "utf8",
);

test("reset migration caches FK ordering edges before the table deletion loop", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE FUNCTION public.admin_data_reset_execute_base(text[], text, uuid)
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE candidate record; remaining text[] := ARRAY['child','parent'];
      BEGIN
        WHILE cardinality(remaining)>0 LOOP
          SELECT t.table_name INTO candidate FROM unnest(remaining) AS t(table_name)
           WHERE NOT EXISTS (
             SELECT 1 FROM pg_constraint fk
              WHERE fk.contype='f' AND fk.conrelid::regclass::text=ANY(remaining)
           ) ORDER BY t.table_name LIMIT 1;
          IF candidate.table_name IS NULL THEN RAISE EXCEPTION 'cycle'; END IF;
          remaining := ARRAY[]::text[];
        END LOOP;
        RETURN '{}'::jsonb;
      END $$;
    `);
    await db.exec(migration);
    await db.exec(migration);
    const definition = await db.query(`
      SELECT pg_get_functiondef('public.admin_data_reset_execute_base(text[],text,uuid)'::regprocedure) AS ddl
    `);
    assert.match(definition.rows[0].ddl, /CREATE TEMP TABLE IF NOT EXISTS _idmc_reset_fk_dependencies/);
    assert.match(definition.rows[0].ddl, /dependency\.child_name=ANY\(remaining\)/);
  } finally {
    await db.close();
  }
});
