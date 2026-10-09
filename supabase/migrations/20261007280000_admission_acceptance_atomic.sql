-- Keep acceptance, offer/application synchronization triggers and audit history
-- in one transaction for the staff admissions workflow.
BEGIN;

CREATE OR REPLACE FUNCTION public.transition_admission_acceptance_atomic(
  p_acceptance_id uuid,
  p_status text,
  p_actor_id uuid,
  p_reason text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS public.admission_acceptances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.admission_acceptances%ROWTYPE;
  v_after public.admission_acceptances%ROWTYPE;
  v_offer public.admission_offers%ROWTYPE;
BEGIN
  IF p_status NOT IN ('ACCEPTED', 'DECLINED') THEN
    RAISE EXCEPTION 'Acceptance status must be ACCEPTED or DECLINED.' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated actor is required.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'DECLINED' AND (p_reason IS NULL OR length(btrim(p_reason)) = 0) THEN
    RAISE EXCEPTION 'A decline reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before
    FROM public.admission_acceptances
   WHERE id = p_acceptance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admission acceptance was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_before.acceptance_status <> 'PENDING' THEN
    RAISE EXCEPTION 'Admission acceptance is already %.', v_before.acceptance_status USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_offer
    FROM public.admission_offers
   WHERE id = v_before.admission_offer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admission offer was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF p_status = 'ACCEPTED' AND v_offer.offer_status <> 'ISSUED' THEN
    RAISE EXCEPTION 'Only an issued admission offer can be accepted.' USING ERRCODE = '23514';
  END IF;
  IF p_status = 'ACCEPTED' AND v_offer.expiry_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'Admission offer has expired.' USING ERRCODE = '23514';
  END IF;

  UPDATE public.admission_acceptances
     SET acceptance_status = p_status,
         accepted_at = CASE WHEN p_status = 'ACCEPTED' THEN now() ELSE accepted_at END,
         declined_at = CASE WHEN p_status = 'DECLINED' THEN now() ELSE NULL END,
         decline_reason = CASE WHEN p_status = 'DECLINED' THEN btrim(p_reason) ELSE NULL END,
         acceptance_ip_address = p_ip_address,
         acceptance_user_agent = left(p_user_agent, 1000),
         accepted_by = p_actor_id,
         updated_at = now()
   WHERE id = p_acceptance_id
     AND acceptance_status = 'PENDING'
   RETURNING * INTO v_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admission acceptance changed; reload and try again.' USING ERRCODE = '40001';
  END IF;

  -- Existing BEFORE/AFTER triggers synchronize offer and application status.
  -- The audit insert shares this transaction, so any failure rolls all writes back.
  INSERT INTO public.audit_logs (
    user_id, action_code, module_code, entity_type, entity_id,
    old_values, new_values, ip_address, user_agent, request_id
  ) VALUES (
    p_actor_id,
    CASE WHEN p_status = 'ACCEPTED' THEN 'ADMISSION_ACCEPT' ELSE 'ADMISSION_DECLINE' END,
    'ADMISSIONS', 'admission_acceptances', p_acceptance_id,
    to_jsonb(v_before), to_jsonb(v_after), p_ip_address, left(p_user_agent, 1000), p_request_id
  );

  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_admission_acceptance_atomic(uuid, text, uuid, text, inet, text, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_admission_acceptance_atomic(uuid, text, uuid, text, inet, text, varchar) TO service_role;

COMMIT;
