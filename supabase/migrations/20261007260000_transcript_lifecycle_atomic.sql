-- Serialize transcript review, approval, issue and revocation with atomic audit.
BEGIN;

CREATE OR REPLACE FUNCTION public.transition_student_transcript_atomic(
  p_transcript_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.student_transcripts%ROWTYPE;
  v_after public.student_transcripts%ROWTYPE;
  v_next_status text;
  v_action_code text;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'An authenticated transcript officer is required.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_before
    FROM public.student_transcripts
   WHERE id = p_transcript_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transcript not found.' USING ERRCODE = 'P0002'; END IF;

  CASE upper(trim(p_action))
    WHEN 'REVIEW' THEN
      v_next_status := 'REVIEW'; v_action_code := 'TRANSCRIPT_REVIEW';
      IF v_before.transcript_status <> 'GENERATED' THEN RAISE EXCEPTION 'Only GENERATED transcripts can enter review.' USING ERRCODE = '23514'; END IF;
    WHEN 'APPROVE' THEN
      v_next_status := 'APPROVED'; v_action_code := 'TRANSCRIPT_APPROVE';
      IF v_before.transcript_status <> 'REVIEW' THEN RAISE EXCEPTION 'Only REVIEW transcripts can be approved.' USING ERRCODE = '23514'; END IF;
      IF v_before.generated_by = p_actor_id THEN RAISE EXCEPTION 'The transcript generator cannot approve the same transcript.' USING ERRCODE = '23514'; END IF;
    WHEN 'ISSUE' THEN
      v_next_status := 'ISSUED'; v_action_code := 'TRANSCRIPT_ISSUE';
      IF v_before.transcript_status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED transcripts can be issued.' USING ERRCODE = '23514'; END IF;
      IF v_before.approved_by = p_actor_id THEN RAISE EXCEPTION 'The transcript approver cannot issue the same transcript.' USING ERRCODE = '23514'; END IF;
    WHEN 'REVOKE' THEN
      v_next_status := 'REVOKED'; v_action_code := 'TRANSCRIPT_REVOKE';
      IF v_before.transcript_status <> 'ISSUED' THEN RAISE EXCEPTION 'Only ISSUED transcripts can be revoked.' USING ERRCODE = '23514'; END IF;
      IF length(trim(COALESCE(p_reason,''))) < 5 OR length(trim(p_reason)) > 500 THEN RAISE EXCEPTION 'A revocation reason of 5 to 500 characters is required.' USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported transcript action.' USING ERRCODE = '22023';
  END CASE;

  UPDATE public.student_transcripts
     SET transcript_status = v_next_status,
         approved_by = CASE WHEN v_next_status = 'APPROVED' THEN p_actor_id ELSE approved_by END,
         approved_at = CASE WHEN v_next_status = 'APPROVED' THEN now() ELSE approved_at END,
         issued_by = CASE WHEN v_next_status = 'ISSUED' THEN p_actor_id ELSE issued_by END,
         issued_at = CASE WHEN v_next_status = 'ISSUED' THEN now() ELSE issued_at END,
         revoked_by = CASE WHEN v_next_status = 'REVOKED' THEN p_actor_id ELSE revoked_by END,
         revoked_at = CASE WHEN v_next_status = 'REVOKED' THEN now() ELSE revoked_at END,
         remarks = CASE WHEN v_next_status = 'REVOKED' THEN trim(p_reason) ELSE remarks END,
         updated_at = now()
   WHERE id = p_transcript_id AND transcript_status = v_before.transcript_status
   RETURNING * INTO v_after;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transcript state changed during this action; refresh and retry.' USING ERRCODE = '40001'; END IF;

  INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id)
  VALUES(p_actor_id,v_action_code,'TRANSCRIPTS','student_transcripts',p_transcript_id,to_jsonb(v_before),to_jsonb(v_after),p_ip_address,p_request_id);
  RETURN to_jsonb(v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_student_transcript_atomic(uuid, uuid, text, text, inet, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_student_transcript_atomic(uuid, uuid, text, text, inet, varchar) TO service_role;

COMMIT;
