-- Commit an approved decision, offer and application status as one Admissions operation.
BEGIN;

CREATE OR REPLACE FUNCTION public.issue_admission_offer_atomic(
  p_application_id uuid,
  p_actor_id uuid,
  p_offer_number text,
  p_expiry_date date,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_select_application boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_application public.applications%ROWTYPE;
  v_choice public.application_choices%ROWTYPE;
  v_decision public.admission_decisions%ROWTYPE;
  v_offer public.admission_offers%ROWTYPE;
  v_new_decision boolean := false;
  v_new_offer boolean := false;
BEGIN
  SELECT * INTO v_application
  FROM public.applications
  WHERE id=p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE='P0002';
  END IF;
  IF p_select_application THEN
    IF v_application.status NOT IN ('VERIFIED','ELIGIBLE','SELECTED','ADMISSION_OFFERED') THEN
      RAISE EXCEPTION 'A verified application must be eligible or selected before issuing an offer. Current status: %.', v_application.status USING ERRCODE='P0001';
    END IF;
  ELSIF v_application.status NOT IN ('SELECTED','ADMISSION_OFFERED') THEN
    RAISE EXCEPTION 'An offer can only be issued for a selected application. Current status: %.', v_application.status USING ERRCODE='P0001';
  END IF;
  IF v_application.verification_status <> 'VERIFIED' THEN
    RAISE EXCEPTION 'Verify the application before issuing an admission offer.' USING ERRCODE='P0001';
  END IF;
  PERFORM 1 FROM public.applicants WHERE id=v_application.applicant_id FOR UPDATE;
  PERFORM 1 FROM public.academic_qualifications WHERE applicant_id=v_application.applicant_id FOR SHARE;
  PERFORM 1 FROM public.application_documents WHERE application_id=p_application_id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.academic_qualifications
    WHERE applicant_id=v_application.applicant_id AND verification_status='VERIFIED'
  ) OR EXISTS (
    SELECT 1 FROM public.academic_qualifications
    WHERE applicant_id=v_application.applicant_id AND verification_status <> 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'Verify all applicant qualifications before issuing an offer.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.application_documents
    WHERE application_id=p_application_id AND verification_status='VERIFIED'
  ) OR EXISTS (
    SELECT 1 FROM public.application_documents
    WHERE application_id=p_application_id AND verification_status <> 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'Verify all application documents before issuing an offer.' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_choice
  FROM public.application_choices
  WHERE application_id=p_application_id AND status='SELECTED'
  ORDER BY choice_number
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_choice
    FROM public.application_choices
    WHERE application_id=p_application_id AND status IN ('PENDING','ELIGIBLE')
    ORDER BY choice_number
    LIMIT 1
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Select a programme before issuing the admission offer.' USING ERRCODE='P0001';
  END IF;
  UPDATE public.application_choices SET status='SELECTED',updated_at=now() WHERE id=v_choice.id;
  v_choice.status := 'SELECTED';

  SELECT * INTO v_decision
  FROM public.admission_decisions
  WHERE application_id=p_application_id AND decision_status='APPROVED'
  ORDER BY (application_choice_id=v_choice.id) DESC, approved_at DESC NULLS LAST, created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND AND v_decision.application_choice_id IS NOT NULL AND v_decision.application_choice_id <> v_choice.id THEN
    RAISE EXCEPTION 'An approved admission decision exists for a different programme choice.' USING ERRCODE='P0001';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.admission_decisions(
      application_id,application_choice_id,decision_type,decision_status,decision_date,decision_reason,
      capacity_check,academic_check,document_check,approved_by,approved_at
    ) VALUES (
      p_application_id,v_choice.id,'SELECTED','APPROVED',now(),'Approved by Admissions',
      true,true,true,p_actor_id,now()
    ) RETURNING * INTO v_decision;
    v_new_decision := true;
  END IF;

  SELECT * INTO v_offer
  FROM public.admission_offers
  WHERE application_id=p_application_id AND offer_status IN ('ISSUED','ACCEPTED')
  ORDER BY issued_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    IF NULLIF(btrim(p_offer_number),'') IS NULL OR p_expiry_date IS NULL OR p_expiry_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'A valid offer number and future expiry date are required.' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.admission_offers(
      application_id,programme_id,decision_id,offer_number,offer_date,expiry_date,offer_status,
      admission_conditions,issued_by,issued_at
    ) VALUES (
      p_application_id,v_choice.programme_id,v_decision.id,p_offer_number,CURRENT_DATE,p_expiry_date,'ISSUED',
      'Admission approved subject to institutional registration requirements.',p_actor_id,now()
    ) RETURNING * INTO v_offer;
    v_new_offer := true;
  END IF;

  UPDATE public.applications
  SET status='ADMISSION_OFFERED',eligibility_status='ELIGIBLE',selection_status='SELECTED',
      reviewed_by=p_actor_id,reviewed_at=now(),updated_at=now()
  WHERE id=p_application_id;

  INSERT INTO public.audit_logs(
    user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id
  ) VALUES (
    p_actor_id,CASE WHEN v_new_offer THEN 'ADMISSION_OFFER_ISSUED' ELSE 'ADMISSION_OFFER_REUSED' END,
    'admissions','admission_offer',v_offer.id,
    jsonb_build_object('application_status',v_application.status,'decision_created',v_new_decision),
    jsonb_build_object('application_status','ADMISSION_OFFERED','offer_number',v_offer.offer_number,
      'offer_status',v_offer.offer_status,'programme_id',v_offer.programme_id),
    p_ip_address,NULLIF(p_request_id,'')
  );

  RETURN jsonb_build_object(
    'offer',to_jsonb(v_offer),'newly_issued',v_new_offer,
    'decision',to_jsonb(v_decision),'choice',to_jsonb(v_choice)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.issue_admission_offer_atomic(uuid,uuid,text,date,text,inet,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_admission_offer_atomic(uuid,uuid,text,date,text,inet,boolean) TO service_role;

COMMIT;
