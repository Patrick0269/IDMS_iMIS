-- Verify an application's qualifications, documents and application state as one unit.
BEGIN;

CREATE OR REPLACE FUNCTION public.verify_application_records_atomic(
  p_application_id uuid,
  p_actor_id uuid,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_application public.applications%ROWTYPE;
  v_qualification_count integer;
  v_document_count integer;
  v_qualification_updates integer;
  v_document_updates integer;
  v_old_qualification_states jsonb;
  v_old_document_states jsonb;
BEGIN
  SELECT * INTO v_application
  FROM public.applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE='P0002';
  END IF;
  IF v_application.status NOT IN ('SUBMITTED','PAYMENT_CONFIRMED','UNDER_REVIEW','CORRECTION_REQUIRED','VERIFIED') THEN
    RAISE EXCEPTION 'Application status % cannot be verified.', v_application.status USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_qualification_count
  FROM public.academic_qualifications WHERE applicant_id=v_application.applicant_id;
  SELECT COALESCE(jsonb_object_agg(verification_status, state_count), '{}'::jsonb)
    INTO v_old_qualification_states
  FROM (
    SELECT verification_status, count(*) AS state_count
    FROM public.academic_qualifications
    WHERE applicant_id = v_application.applicant_id
    GROUP BY verification_status
  ) states;
  SELECT count(*) INTO v_document_count
  FROM public.application_documents WHERE application_id=p_application_id;
  SELECT COALESCE(jsonb_object_agg(verification_status, state_count), '{}'::jsonb)
    INTO v_old_document_states
  FROM (
    SELECT verification_status, count(*) AS state_count
    FROM public.application_documents
    WHERE application_id = p_application_id
    GROUP BY verification_status
  ) states;

  IF v_qualification_count = 0 THEN
    RAISE EXCEPTION 'No qualification is attached.' USING ERRCODE='P0001';
  END IF;
  IF v_document_count = 0 THEN
    RAISE EXCEPTION 'No certificate document is attached.' USING ERRCODE='P0001';
  END IF;

  UPDATE public.academic_qualifications
  SET verification_status='VERIFIED', verified_by=p_actor_id, verified_at=now(), updated_at=now()
  WHERE applicant_id=v_application.applicant_id;
  GET DIAGNOSTICS v_qualification_updates = ROW_COUNT;

  UPDATE public.application_documents
  SET verification_status='VERIFIED', verified_by=p_actor_id, verified_at=now(), rejection_reason=NULL, updated_at=now()
  WHERE application_id=p_application_id;
  GET DIAGNOSTICS v_document_updates = ROW_COUNT;

  IF v_qualification_updates <> v_qualification_count OR v_document_updates <> v_document_count THEN
    RAISE EXCEPTION 'Application records changed during verification; refresh and retry.' USING ERRCODE='40001';
  END IF;

  UPDATE public.applications
  SET status='VERIFIED', verification_status='VERIFIED', reviewed_by=p_actor_id,
      reviewed_at=now(), updated_at=now()
  WHERE id=p_application_id;

  INSERT INTO public.audit_logs(
    user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id
  ) VALUES (
    p_actor_id,'ADMISSIONS_VERIFY_ALL','admissions','application',p_application_id,
    jsonb_build_object('status',v_application.status,'verification_status',v_application.verification_status,
      'qualification_states',v_old_qualification_states,'document_states',v_old_document_states),
    jsonb_build_object('status','VERIFIED','verification_status','VERIFIED',
      'qualifications_verified',v_qualification_updates,'documents_verified',v_document_updates),
    p_ip_address,NULLIF(p_request_id,'')
  );

  RETURN jsonb_build_object(
    'application_id',p_application_id,'status','VERIFIED',
    'qualifications_verified',v_qualification_updates,'documents_verified',v_document_updates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_application_records_atomic(uuid,uuid,text,inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_application_records_atomic(uuid,uuid,text,inet) TO service_role;

COMMIT;
