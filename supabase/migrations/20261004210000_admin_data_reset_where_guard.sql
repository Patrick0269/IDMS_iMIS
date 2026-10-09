BEGIN;
CREATE OR REPLACE FUNCTION public.admin_data_reset_execute(p_categories text[], p_project_reference text, p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE candidate record; deleted_count bigint; total_count bigint:=0; counts jsonb:='{}'::jsonb;
  remaining text[]; targets text[]; protected_student_id uuid; protected_user_id uuid;
  kept_admins uuid[]; kept_auth_ids uuid[]; removed_auth_ids uuid[]; run_id uuid;
BEGIN
  targets:=public.admin_data_reset_targets(p_categories);
  IF length(trim(coalesce(p_project_reference,'')))<8 THEN RAISE EXCEPTION 'Active project reference is unavailable.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor_user_id) THEN RAISE EXCEPTION 'Admin actor could not be verified.'; END IF;
  SELECT s.id,s.user_id INTO protected_student_id,protected_user_id FROM public.students s
   WHERE s.student_number='IDMC/2026/00001' OR s.registration_number='IDMC/2026/00001' LIMIT 1;
  IF protected_user_id IS NULL AND 'everything'=ANY(p_categories) THEN
    SELECT id INTO protected_user_id FROM public.users
     WHERE lower(username)=lower('IDMC/2026/00001') OR user_number IN ('IDMC/2026/00001','2026/00001') ORDER BY id LIMIT 1;
  END IF;
  SELECT array_agg(DISTINCT ur.user_id) INTO kept_admins FROM public.user_roles ur JOIN public.roles ro ON ro.id=ur.role_id
   WHERE ro.role_code IN ('ADMIN','SUPER_ADMIN');
  kept_admins:=coalesce(kept_admins,ARRAY[]::uuid[]);
  IF NOT p_actor_user_id=ANY(kept_admins) THEN kept_admins:=array_append(kept_admins,p_actor_user_id); END IF;
  IF 'students'=ANY(targets) AND protected_student_id IS NULL THEN RAISE EXCEPTION 'Protected student IDMC/2026/00001 was not found. No data was deleted.'; END IF;
  IF 'users'=ANY(targets) AND to_regclass('public.users') IS NOT NULL THEN
    SELECT array_agg(DISTINCT auth_user_id) INTO removed_auth_ids FROM public.users
     WHERE id<>ALL(kept_admins) AND id IS DISTINCT FROM protected_user_id AND auth_user_id IS NOT NULL;
    SELECT array_agg(DISTINCT auth_user_id) INTO kept_auth_ids FROM public.users
     WHERE id=ANY(kept_admins) OR id=protected_user_id;
  ELSE
    removed_auth_ids:=ARRAY[]::uuid[];
    SELECT array_agg(DISTINCT auth_user_id) INTO kept_auth_ids FROM public.users WHERE id=ANY(kept_admins) OR id=protected_user_id;
  END IF;
  kept_auth_ids:=coalesce(kept_auth_ids,ARRAY[]::uuid[]);
  remaining:=targets;
  CREATE TEMP TABLE IF NOT EXISTS _idmc_reset_counts(table_name text PRIMARY KEY,deleted_rows bigint) ON COMMIT DROP;
  TRUNCATE _idmc_reset_counts;
  WHILE cardinality(remaining)>0 LOOP
    SELECT t.table_name INTO candidate FROM unnest(remaining) AS t(table_name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
       WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
         AND parent.relname=t.table_name AND child.relname=ANY(remaining) AND child.relname<>parent.relname
     ) ORDER BY t.table_name LIMIT 1;
    IF candidate.table_name IS NULL THEN RAISE EXCEPTION 'Selected records contain circular foreign-key dependencies. No records were deleted.'; END IF;
    IF candidate.table_name='students' AND protected_student_id IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.students WHERE id<>$1' USING protected_student_id;
    ELSIF candidate.table_name='users' THEN
      EXECUTE 'DELETE FROM public.users WHERE id<>ALL($1) AND id IS DISTINCT FROM $2' USING kept_admins,protected_user_id;
    ELSIF candidate.table_name='user_roles' THEN
      EXECUTE 'DELETE FROM public.user_roles WHERE user_id<>ALL($1) AND user_id IS DISTINCT FROM $2' USING kept_admins,protected_user_id;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE true',candidate.table_name);
    END IF;
    GET DIAGNOSTICS deleted_count=ROW_COUNT;
    INSERT INTO _idmc_reset_counts VALUES(candidate.table_name,deleted_count) ON CONFLICT(table_name) DO UPDATE SET deleted_rows=excluded.deleted_rows;
    total_count:=total_count+deleted_count;
    remaining:=array_remove(remaining,candidate.table_name);
  END LOOP;
  SELECT coalesce(jsonb_object_agg(table_name,deleted_rows),'{}'::jsonb) INTO counts FROM _idmc_reset_counts;
  INSERT INTO public.admin_data_reset_runs(actor_user_id,project_reference,categories,deleted_rows,total_deleted)
   VALUES(p_actor_user_id,p_project_reference,p_categories,counts,total_count) RETURNING id INTO run_id;
  RETURN jsonb_build_object('runId',run_id,'deletedRows',counts,'totalDeleted',total_count,
    'preservedStudent','IDMC/2026/00001','preservedAdminUsers',cardinality(kept_admins),
    'deleteAuthUserIds',to_jsonb(coalesce(removed_auth_ids,ARRAY[]::uuid[])),
    'preservedAuthUserIds',to_jsonb(kept_auth_ids));
END $$;
REVOKE ALL ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) TO service_role;
COMMIT;

