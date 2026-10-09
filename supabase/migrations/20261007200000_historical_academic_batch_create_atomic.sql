-- Save a validated academic batch, all rows and its audit event atomically.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_historical_academic_import_batch(
  p_batch_payload jsonb,
  p_rows jsonb,
  p_actor_id uuid,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_row jsonb;
  v_count integer;
  v_valid integer := 0;
  v_invalid integer := 0;
  v_duplicates integer := 0;
  v_batch_status text;
BEGIN
  IF jsonb_typeof(p_batch_payload) <> 'object' OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Batch details and rows are required.' USING ERRCODE='22023';
  END IF;
  v_count := jsonb_array_length(p_rows);
  IF v_count < 1 OR v_count > 5000 THEN
    RAISE EXCEPTION 'Academic import batches must contain 1 to 5,000 rows.' USING ERRCODE='22023';
  END IF;
  IF NULLIF(btrim(p_batch_payload->>'batch_number'),'') IS NULL
     OR NULLIF(p_batch_payload->>'institution_id','') IS NULL
     OR NULLIF(p_batch_payload->>'source_format','') NOT IN ('CSV','XLSX','MANUAL') THEN
    RAISE EXCEPTION 'Batch number, institution and supported source format are required.' USING ERRCODE='22023';
  END IF;

  FOR v_row IN SELECT item FROM jsonb_array_elements(p_rows) AS items(item) LOOP
    IF jsonb_typeof(v_row) <> 'object'
       OR jsonb_typeof(v_row->'raw') <> 'object'
       OR jsonb_typeof(v_row->'normalized') <> 'object'
       OR jsonb_typeof(v_row->'errors') <> 'array'
       OR NULLIF(v_row->>'rowNumber','') IS NULL
       OR (v_row->>'validationStatus') NOT IN ('VALID','INVALID','DUPLICATE') THEN
      RAISE EXCEPTION 'Academic import row payload is incomplete or invalid.' USING ERRCODE='22023';
    END IF;
    IF v_row->>'validationStatus'='VALID' THEN v_valid := v_valid + 1;
    ELSIF v_row->>'validationStatus'='INVALID' THEN v_invalid := v_invalid + 1;
    ELSE v_duplicates := v_duplicates + 1;
    END IF;
  END LOOP;
  IF (p_batch_payload->>'total_rows')::integer <> v_count
     OR (p_batch_payload->>'valid_rows')::integer <> v_valid
     OR (p_batch_payload->>'invalid_rows')::integer <> v_invalid
     OR (p_batch_payload->>'duplicate_rows')::integer <> v_duplicates THEN
    RAISE EXCEPTION 'Batch summary does not match the row data.' USING ERRCODE='22023';
  END IF;

  v_batch_status := CASE WHEN v_invalid > 0 OR v_duplicates > 0 THEN 'VALIDATED' ELSE 'READY' END;
  INSERT INTO public.historical_academic_import_batches(
    batch_number,institution_id,source_format,source_file_name,source_file_sha256,status,
    total_rows,valid_rows,invalid_rows,duplicate_rows,created_by,validated_at
  ) VALUES (
    p_batch_payload->>'batch_number',(p_batch_payload->>'institution_id')::uuid,
    p_batch_payload->>'source_format',NULLIF(p_batch_payload->>'source_file_name',''),
    NULLIF(p_batch_payload->>'source_file_sha256',''),v_batch_status,
    v_count,v_valid,v_invalid,v_duplicates,p_actor_id,now()
  ) RETURNING * INTO v_batch;

  INSERT INTO public.historical_academic_import_rows(
    batch_id,row_number,raw_data,normalized_data,validation_status,validation_errors
  )
  SELECT v_batch.id,(item->>'rowNumber')::integer,item->'raw',item->'normalized',
         item->>'validationStatus',item->'errors'
    FROM jsonb_array_elements(p_rows) AS items(item);

  INSERT INTO public.audit_logs(
    user_id,action_code,module_code,entity_type,entity_id,new_values,ip_address,request_id
  ) VALUES (
    p_actor_id,'HISTORICAL_ACADEMIC_VALIDATE','historical_academics',
    'historical_academic_import_batch',v_batch.id,
    jsonb_build_object('batch_number',v_batch.batch_number,'total',v_count,'valid',v_valid,'invalid',v_invalid,'duplicates',v_duplicates),
    p_ip_address,NULLIF(p_request_id,'')
  );
  RETURN to_jsonb(v_batch);
END;
$$;

REVOKE ALL ON FUNCTION public.create_historical_academic_import_batch(jsonb,jsonb,uuid,text,inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_historical_academic_import_batch(jsonb,jsonb,uuid,text,inet) TO service_role;

COMMIT;
