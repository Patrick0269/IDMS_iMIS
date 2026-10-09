-- Serialize registration approval, approval history and audit in one transaction.
BEGIN;
CREATE OR REPLACE FUNCTION public.approve_student_registration_atomic(
  p_registration_id uuid, p_actor_id uuid, p_approval_level integer DEFAULT 1,
  p_approval_role varchar DEFAULT 'ACADEMIC', p_comments text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL, p_request_id varchar DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_before public.student_registrations%ROWTYPE; v_after public.student_registrations%ROWTYPE; v_approval public.registration_approvals%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'An authenticated registration approver is required.' USING ERRCODE = '22023'; END IF;
  IF p_approval_level IS NULL OR p_approval_level < 1 THEN RAISE EXCEPTION 'Approval level must be positive.' USING ERRCODE = '22023'; END IF;
  IF p_approval_role IS NULL OR length(btrim(p_approval_role)) = 0 OR length(btrim(p_approval_role)) > 80 THEN RAISE EXCEPTION 'A valid approval role is required.' USING ERRCODE = '22023'; END IF;
  IF p_comments IS NOT NULL AND length(p_comments) > 2000 THEN RAISE EXCEPTION 'Approval comments cannot exceed 2000 characters.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_before FROM public.student_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student registration was not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_before.registration_status NOT IN ('SUBMITTED','PENDING_APPROVAL') THEN RAISE EXCEPTION 'Registration cannot be approved from %.', v_before.registration_status USING ERRCODE = '23514'; END IF;
  IF v_before.academic_eligibility_status <> 'ELIGIBLE' OR v_before.finance_eligibility_status NOT IN ('CLEARED','OVERRIDE') OR v_before.document_eligibility_status NOT IN ('CLEARED','OVERRIDE') THEN RAISE EXCEPTION 'Registration eligibility requirements are not satisfied.' USING ERRCODE = '23514'; END IF;
  UPDATE public.student_registrations SET registration_status='APPROVED', approved_by=p_actor_id, approved_at=now(), updated_by=p_actor_id, updated_at=now()
   WHERE id=p_registration_id AND registration_status IN ('SUBMITTED','PENDING_APPROVAL') RETURNING * INTO v_after;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration state changed; refresh and retry.' USING ERRCODE = '40001'; END IF;
  INSERT INTO public.registration_approvals(student_registration_id,approval_level,approval_role,approval_status,comments,approved_by,approved_at,created_at,updated_at)
  VALUES(p_registration_id,p_approval_level,btrim(p_approval_role),'APPROVED',p_comments,p_actor_id,now(),now(),now())
  ON CONFLICT(student_registration_id,approval_level) DO UPDATE SET approval_role=EXCLUDED.approval_role,approval_status='APPROVED',comments=EXCLUDED.comments,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at,rejected_at=NULL,updated_at=now()
  RETURNING * INTO v_approval;
  INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id)
  VALUES(p_actor_id,'REGISTRATION_APPROVE','REGISTRATION','student_registrations',p_registration_id,to_jsonb(v_before),jsonb_build_object('registration',to_jsonb(v_after),'approval',to_jsonb(v_approval)),p_ip_address,p_request_id);
  RETURN jsonb_build_object('registration',to_jsonb(v_after),'approval',to_jsonb(v_approval));
END; $$;
REVOKE ALL ON FUNCTION public.approve_student_registration_atomic(uuid,uuid,integer,character varying,text,inet,character varying) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_student_registration_atomic(uuid,uuid,integer,character varying,text,inet,character varying) TO service_role;
COMMIT;
