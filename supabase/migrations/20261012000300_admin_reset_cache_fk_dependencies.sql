BEGIN;

-- The reset used to rescan pg_constraint for every table in the selected set.
-- Materialize its FK ordering edges once per reset transaction instead.
DO $migration$
DECLARE
  ddl text;
  candidate_start integer;
  candidate_end integer;
  loop_start integer;
  replacement text := $replacement$
    SELECT t.table_name INTO candidate
      FROM unnest(remaining) AS t(table_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM _idmc_reset_fk_dependencies dependency
        WHERE dependency.parent_name=t.table_name
          AND dependency.child_name=ANY(remaining)
     )
     ORDER BY t.table_name LIMIT 1;
    $replacement$;
  setup text := $setup$
  CREATE TEMP TABLE IF NOT EXISTS _idmc_reset_fk_dependencies(
    child_name text NOT NULL,
    parent_name text NOT NULL,
    PRIMARY KEY(child_name,parent_name)
  ) ON COMMIT DROP;
  TRUNCATE _idmc_reset_fk_dependencies;
  INSERT INTO _idmc_reset_fk_dependencies(child_name,parent_name)
  WITH RECURSIVE fk_relations(child_oid,relid) AS (
    SELECT con.conrelid,con.conrelid
      FROM pg_constraint con
      JOIN pg_class parent ON parent.oid=con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
     WHERE con.contype='f'
       AND con.connamespace='public'::regnamespace
       AND parent_ns.nspname='public'
    UNION ALL
    SELECT fk_relations.child_oid,inheritance.inhparent
      FROM fk_relations
      JOIN pg_inherits inheritance ON inheritance.inhrelid=fk_relations.relid
  )
  SELECT DISTINCT child_parent.relname,parent.relname
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
    JOIN fk_relations ON fk_relations.child_oid=con.conrelid
    JOIN pg_class child_parent ON child_parent.oid=fk_relations.relid
    JOIN pg_namespace child_ns ON child_ns.oid=child_parent.relnamespace
   WHERE con.contype='f'
     AND con.connamespace='public'::regnamespace
     AND child_ns.nspname='public'
     AND parent_ns.nspname='public'
     AND child_parent.relname<>parent.relname;
  $setup$;
BEGIN
  ddl:=pg_get_functiondef('public.admin_data_reset_execute_base(text[],text,uuid)'::regprocedure);
  -- Safe when the SQL is first run from the dashboard and later replayed by
  -- the CLI after its migration-role connection is repaired.
  IF position('CREATE TEMP TABLE IF NOT EXISTS _idmc_reset_fk_dependencies' in ddl)=0 THEN
    candidate_start:=position('SELECT t.table_name INTO candidate FROM unnest(remaining) AS t(table_name)' in ddl);
    candidate_end:=position('IF candidate.table_name IS NULL THEN' in ddl);
    loop_start:=position('WHILE cardinality(remaining)>0 LOOP' in ddl);
    IF candidate_start=0 OR candidate_end<=candidate_start OR loop_start=0 THEN
      RAISE EXCEPTION 'Could not locate the reset ordering loop; no reset function was changed.';
    END IF;
    ddl:=overlay(ddl placing replacement from candidate_start for candidate_end-candidate_start);
    loop_start:=position('WHILE cardinality(remaining)>0 LOOP' in ddl);
    ddl:=overlay(ddl placing setup||E'\n  ' from loop_start for 0);
    EXECUTE ddl;
  END IF;
END;
$migration$;

COMMIT;
