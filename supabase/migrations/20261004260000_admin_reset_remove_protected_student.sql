BEGIN;

-- Remove the old hard-coded student exemption while continuing to retain the
-- acting admin, role definitions, institutional configuration and reset audit.
DO $$
DECLARE
  ddl text;
  old_student_lookup text := $old$
  SELECT s.id,s.user_id INTO protected_student_id,protected_user_id FROM public.students s
   WHERE s.student_number='IDMC/2026/00001' OR s.registration_number='IDMC/2026/00001' LIMIT 1;
  IF protected_user_id IS NULL AND 'everything'=ANY(p_categories) THEN
    SELECT id INTO protected_user_id FROM public.users
     WHERE lower(username)=lower('IDMC/2026/00001') OR user_number IN ('IDMC/2026/00001','2026/00001') ORDER BY id LIMIT 1;
  END IF;$old$;
  old_required_check text := $old$  IF 'students'=ANY(targets) AND protected_student_id IS NULL THEN RAISE EXCEPTION 'Protected student IDMC/2026/00001 was not found. No data was deleted.'; END IF;$old$;
  old_student_delete text := $old$    IF candidate.table_name='students' AND protected_student_id IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.students WHERE id<>$1' USING protected_student_id;
    ELSIF candidate.table_name='users' THEN$old$;
  old_result text := $old$'preservedStudent','IDMC/2026/00001'$old$;
BEGIN
  ddl := pg_get_functiondef('public.admin_data_reset_execute_base(text[],text,uuid)'::regprocedure);
  IF position(old_student_lookup in ddl)=0 OR position(old_required_check in ddl)=0
     OR position(old_student_delete in ddl)=0 OR position(old_result in ddl)=0 THEN
    RAISE EXCEPTION 'Reset function does not match the expected protected-student version. Migration stopped without changing data.';
  END IF;
  ddl := replace(ddl,old_student_lookup,'  protected_student_id:=NULL; protected_user_id:=NULL;');
  ddl := replace(ddl,old_required_check,'');
  ddl := replace(ddl,old_student_delete,$new$    IF candidate.table_name='students' THEN
      EXECUTE 'DELETE FROM public.students WHERE true';
    ELSIF candidate.table_name='users' THEN$new$);
  ddl := replace(ddl,old_result,$new$'preservedStudent',NULL,'deletedStudentNumber','IDMC/2026/00001'$new$);
  EXECUTE ddl;
END;
$$;

COMMIT;
