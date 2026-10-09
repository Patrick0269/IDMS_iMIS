-- Make academic imports resumable and each attempt/row write idempotent.
BEGIN;

CREATE OR REPLACE FUNCTION public.start_or_resume_historical_academic_import(
  p_batch_id uuid,
  p_actor_id uuid,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_updated public.historical_academic_import_batches%ROWTYPE;
  v_action text;
BEGIN
  SELECT * INTO v_batch FROM public.historical_academic_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Academic import batch was not found.' USING ERRCODE='P0002'; END IF;
  IF v_batch.created_by = p_actor_id THEN
    RAISE EXCEPTION 'Four-eyes control: the officer who validated this batch cannot confirm it.' USING ERRCODE='42501';
  END IF;

  IF v_batch.status = 'READY' THEN
    UPDATE public.historical_academic_import_batches
       SET status='IMPORTING', confirmed_by=p_actor_id, confirmed_at=now(), updated_at=now()
     WHERE id=p_batch_id RETURNING * INTO v_updated;
    v_action := 'HISTORICAL_ACADEMIC_CONFIRM_STARTED';
  ELSIF v_batch.status = 'IMPORTING' THEN
    IF v_batch.confirmed_by IS DISTINCT FROM p_actor_id THEN
      UPDATE public.historical_academic_import_batches
         SET confirmed_by=p_actor_id, updated_at=now()
       WHERE id=p_batch_id RETURNING * INTO v_updated;
      v_action := 'HISTORICAL_ACADEMIC_IMPORT_RESUMED';
    ELSE
      v_updated := v_batch;
    END IF;
  ELSIF v_batch.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') THEN
    RETURN to_jsonb(v_batch);
  ELSE
    RAISE EXCEPTION 'Only a clean READY or interrupted IMPORTING batch can be confirmed.' USING ERRCODE='23514';
  END IF;

  IF v_action IS NOT NULL THEN
    INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id)
    VALUES (p_actor_id,v_action,'historical_academics','historical_academic_import_batch',p_batch_id,
      to_jsonb(v_batch),to_jsonb(v_updated),p_ip_address,NULLIF(p_request_id,''));
  END IF;
  RETURN to_jsonb(v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.import_historical_academic_attempt(
  p_batch_id uuid,
  p_row_id uuid,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_row public.historical_academic_import_rows%ROWTYPE;
  v_data jsonb;
  v_attempt_id uuid;
BEGIN
  SELECT * INTO v_batch FROM public.historical_academic_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status <> 'IMPORTING' OR v_batch.confirmed_by IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'This officer does not own an active import run for this batch.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.historical_academic_import_rows WHERE id=p_row_id AND batch_id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Academic import row was not found.' USING ERRCODE='P0002'; END IF;
  IF v_row.validation_status='IMPORTED' THEN
    IF v_row.course_attempt_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.student_course_attempts a
       WHERE a.id=v_row.course_attempt_id AND a.academic_import_batch_id=p_batch_id
    ) THEN RAISE EXCEPTION 'Imported row linkage is inconsistent; reconcile the batch.' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('attempt_id',v_row.course_attempt_id,'already_imported',true);
  END IF;
  IF v_row.validation_status <> 'VALID' THEN
    RAISE EXCEPTION 'Only a VALID academic import row can be imported.' USING ERRCODE='23514';
  END IF;

  v_data := v_row.normalized_data;
  IF jsonb_typeof(v_data) <> 'object' OR NULLIF(v_data->>'student_id','') IS NULL THEN
    RAISE EXCEPTION 'The normalized academic row is missing a student.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.student_course_attempts(
    student_id, programme_version_id, curriculum_id, academic_year_id, semester_id, course_id,
    import_row_id, attempt_number, attempt_date, coursework_mark, examination_mark, total_mark,
    grade_code, grade_point, credits, pass_status, attempt_status, result_type, source_type,
    recorded_by, recorded_at, locked_by, locked_at, remarks, academic_import_batch_id
  ) VALUES (
    (v_data->>'student_id')::uuid, NULLIF(v_data->>'programme_version_id','')::uuid,
    NULLIF(v_data->>'curriculum_id','')::uuid, (v_data->>'academic_year_id')::uuid,
    (v_data->>'semester_id')::uuid, (v_data->>'course_id')::uuid,
    v_row.id, (v_data->>'attempt_number')::integer, NULLIF(v_data->>'attempt_date','')::date,
    NULLIF(v_data->>'coursework_mark','')::numeric, NULLIF(v_data->>'examination_mark','')::numeric,
    NULLIF(v_data->>'total_mark','')::numeric, NULLIF(v_data->>'grade_code',''),
    NULLIF(v_data->>'grade_point','')::numeric, (v_data->>'credits')::numeric,
    NULLIF(v_data->>'pass_status',''), (v_data->>'attempt_status'),
    COALESCE(NULLIF(v_data->>'result_type',''),'NORMAL'), 'HISTORICAL_IMPORT',
    p_actor_id, now(), CASE WHEN v_data->>'attempt_status'='LOCKED' THEN p_actor_id END,
    CASE WHEN v_data->>'attempt_status'='LOCKED' THEN now() END,
    NULLIF(v_data->>'remarks',''), p_batch_id
  ) RETURNING id INTO v_attempt_id;

  UPDATE public.historical_academic_import_rows
     SET validation_status='IMPORTED', course_attempt_id=v_attempt_id,
         imported_at=now(), validation_errors='[]'::jsonb, updated_at=now()
   WHERE id=v_row.id;
  RETURN jsonb_build_object('attempt_id',v_attempt_id,'already_imported',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_historical_academic_import_row(
  p_batch_id uuid,
  p_row_id uuid,
  p_actor_id uuid,
  p_failure text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_row public.historical_academic_import_rows%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.historical_academic_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status <> 'IMPORTING' OR v_batch.confirmed_by IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'This officer does not own an active import run for this batch.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.historical_academic_import_rows
   WHERE id=p_row_id AND batch_id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Academic import row was not found.' USING ERRCODE='P0002'; END IF;
  IF v_row.validation_status <> 'VALID' THEN
    RAISE EXCEPTION 'Only a VALID academic row can be marked skipped.' USING ERRCODE='23514';
  END IF;
  IF NULLIF(btrim(p_failure),'') IS NULL THEN
    RAISE EXCEPTION 'A failure reason is required.' USING ERRCODE='22023';
  END IF;
  UPDATE public.historical_academic_import_rows
     SET validation_status='SKIPPED', validation_errors=jsonb_build_array(left(p_failure,2000)), updated_at=now()
   WHERE id=p_row_id
   RETURNING * INTO v_row;
  RETURN jsonb_build_object('id',v_row.id,'validation_status',v_row.validation_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_historical_academic_import(
  p_batch_id uuid,
  p_actor_id uuid,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_updated public.historical_academic_import_batches%ROWTYPE;
  v_imported integer;
  v_skipped integer;
  v_pending integer;
  v_final_status text;
BEGIN
  SELECT * INTO v_batch FROM public.historical_academic_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Academic import batch was not found.' USING ERRCODE='P0002'; END IF;
  IF v_batch.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') THEN RETURN to_jsonb(v_batch); END IF;
  IF v_batch.status <> 'IMPORTING' OR v_batch.confirmed_by IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'This officer does not own an active import run for this batch.' USING ERRCODE='42501';
  END IF;
  SELECT count(*) FILTER (WHERE validation_status='IMPORTED'),
         count(*) FILTER (WHERE validation_status='SKIPPED'),
         count(*) FILTER (WHERE validation_status='VALID')
    INTO v_imported,v_skipped,v_pending
    FROM public.historical_academic_import_rows WHERE batch_id=p_batch_id;
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'The academic import still has % valid rows to process.',v_pending USING ERRCODE='55000';
  END IF;
  v_final_status := CASE WHEN v_skipped > 0 THEN 'COMPLETED_WITH_ERRORS' ELSE 'COMPLETED' END;
  UPDATE public.historical_academic_import_batches
     SET status=v_final_status, imported_rows=v_imported, skipped_rows=v_skipped,
         completed_at=now(), updated_at=now()
   WHERE id=p_batch_id RETURNING * INTO v_updated;
  INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id)
  VALUES (p_actor_id,'HISTORICAL_ACADEMIC_CONFIRM','historical_academics','historical_academic_import_batch',p_batch_id,
    to_jsonb(v_batch),to_jsonb(v_updated),p_ip_address,NULLIF(p_request_id,''));
  RETURN to_jsonb(v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.start_or_resume_historical_academic_import(uuid,uuid,text,inet) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_historical_academic_attempt(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_historical_academic_import_row(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_historical_academic_import(uuid,uuid,text,inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_or_resume_historical_academic_import(uuid,uuid,text,inet) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_historical_academic_attempt(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_historical_academic_import_row(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_historical_academic_import(uuid,uuid,text,inet) TO service_role;

COMMIT;
