BEGIN;

-- The protected historical/current student remains. Preserve the minimum
-- admission provenance rows referenced by every student row left after the
-- student-category deletion (normally only IDMC/2026/00001).
DO $$
DECLARE
  ddl text;
  old_statement text := $old$EXECUTE format('DELETE FROM public.%I WHERE true',candidate.table_name);$old$;
  new_statement text := $new$
      IF candidate.table_name='admission_offers' THEN
        EXECUTE 'DELETE FROM public.admission_offers o WHERE NOT EXISTS (SELECT 1 FROM public.students s WHERE s.admission_offer_id=o.id)';
      ELSIF candidate.table_name='applications' THEN
        EXECUTE 'DELETE FROM public.applications a WHERE NOT EXISTS (SELECT 1 FROM public.students s WHERE s.source_application_id=a.id OR EXISTS (SELECT 1 FROM public.admission_offers o WHERE o.id=s.admission_offer_id AND o.application_id=a.id))';
      ELSIF candidate.table_name='applicants' THEN
        EXECUTE 'DELETE FROM public.applicants a WHERE NOT EXISTS (SELECT 1 FROM public.applications ap WHERE ap.applicant_id=a.id)';
      ELSE
        EXECUTE format('DELETE FROM public.%I WHERE true',candidate.table_name);
      END IF;$new$;
BEGIN
  ddl := pg_get_functiondef('public.admin_data_reset_execute_base(text[],text,uuid)'::regprocedure);
  IF position(old_statement in ddl)=0 THEN
    RAISE EXCEPTION 'Could not locate the reset delete statement. Migration stopped; no data was changed.';
  END IF;
  ddl := replace(ddl,old_statement,new_statement);
  EXECUTE ddl;
END;
$$;

COMMIT;
