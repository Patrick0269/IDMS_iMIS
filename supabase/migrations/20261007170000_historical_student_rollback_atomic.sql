-- Keep historical-student rollback state changes and its audit event atomic.
BEGIN;

CREATE OR REPLACE FUNCTION public.rollback_historical_student_import(
  p_batch_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.historical_import_batches%ROWTYPE;
  v_updated public.historical_import_batches%ROWTYPE;
  v_imported_rows bigint;
  v_linked_students bigint;
  v_changed_students bigint;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A rollback reason is required.' USING ERRCODE = '22023';
  END IF;
  IF length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Rollback reason must be 2,000 characters or fewer.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_batch
    FROM public.historical_import_batches
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Historical import batch was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') THEN
    RAISE EXCEPTION 'Only a completed historical import batch can be rolled back.' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_imported_rows
    FROM public.historical_import_rows
   WHERE batch_id = p_batch_id AND validation_status = 'IMPORTED';
  IF EXISTS (
    SELECT 1 FROM public.historical_import_rows
     WHERE batch_id = p_batch_id AND validation_status = 'IMPORTED' AND student_id IS NULL
  ) THEN
    RAISE EXCEPTION 'An imported row has no linked student; reconcile the batch before rollback.' USING ERRCODE = '23514';
  END IF;

  SELECT count(DISTINCT s.id) INTO v_linked_students
    FROM public.historical_import_rows r
    JOIN public.students s ON s.id = r.student_id
   WHERE r.batch_id = p_batch_id
     AND r.validation_status = 'IMPORTED'
     AND s.source_reference = v_batch.batch_number
     AND s.source_type IN ('HISTORICAL_IMPORT', 'MANUAL_ENTRY');
  IF v_linked_students <> v_imported_rows THEN
    RAISE EXCEPTION 'Imported rows and batch-owned students do not match; reconcile the batch before rollback.' USING ERRCODE = '23514';
  END IF;

  UPDATE public.students s
     SET student_status = 'INACTIVE',
         archived_at = now(),
         archived_by = p_actor_id,
         notes = concat_ws(E'\n', NULLIF(s.notes, ''),
           format('Historical batch %s rolled back: %s', v_batch.batch_number, btrim(p_reason))),
         updated_at = now()
    FROM public.historical_import_rows r
   WHERE r.batch_id = p_batch_id
     AND r.validation_status = 'IMPORTED'
     AND r.student_id = s.id
     AND s.source_reference = v_batch.batch_number
     AND s.source_type IN ('HISTORICAL_IMPORT', 'MANUAL_ENTRY');
  GET DIAGNOSTICS v_changed_students = ROW_COUNT;
  IF v_changed_students <> v_imported_rows THEN
    RAISE EXCEPTION 'The imported student set changed during rollback; no changes were committed.' USING ERRCODE = '40001';
  END IF;

  UPDATE public.historical_import_rows
     SET validation_status = 'ROLLED_BACK', updated_at = now()
   WHERE batch_id = p_batch_id AND validation_status = 'IMPORTED';
  UPDATE public.historical_import_batches
     SET status = 'ROLLED_BACK', rolled_back_by = p_actor_id,
         rolled_back_at = now(), rollback_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs(
    user_id, action_code, module_code, entity_type, entity_id,
    old_values, new_values, ip_address, request_id
  ) VALUES (
    p_actor_id, 'HISTORICAL_IMPORT_ROLLBACK', 'historical_students',
    'historical_import_batch', p_batch_id, to_jsonb(v_batch), to_jsonb(v_updated),
    p_ip_address, NULLIF(p_request_id, '')
  );

  RETURN to_jsonb(v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_historical_student_import(uuid, uuid, text, text, inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_historical_student_import(uuid, uuid, text, text, inet) TO service_role;

COMMIT;
