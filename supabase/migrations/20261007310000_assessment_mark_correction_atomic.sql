-- Keep correction decisions, mark changes and their audit event in one transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_locked_assessment_mark_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_assessment_status varchar(30);
BEGIN
  SELECT status INTO v_assessment_status
    FROM public.assessments
   WHERE id = OLD.assessment_id;

  IF v_assessment_status = 'LOCKED'
     AND current_setting('idmc.assessment_correction_rpc', true) IS DISTINCT FROM 'on' THEN
    IF NEW.marks IS DISTINCT FROM OLD.marks
       OR NEW.grade IS DISTINCT FROM OLD.grade
       OR NEW.remarks IS DISTINCT FROM OLD.remarks
       OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.course_registration_id IS DISTINCT FROM OLD.course_registration_id THEN
      RAISE EXCEPTION 'Locked assessment marks can only be changed by the approved correction workflow.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_assessment_mark_correction_atomic(
  p_correction_id uuid,
  p_decision text,
  p_actor_id uuid,
  p_review_comment text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_correction_before public.assessment_mark_corrections%ROWTYPE;
  v_correction_after public.assessment_mark_corrections%ROWTYPE;
  v_mark_before public.assessment_marks%ROWTYPE;
  v_mark_after public.assessment_marks%ROWTYPE;
  v_maximum_marks numeric(8,2);
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated assessment reviewer is required.' USING ERRCODE = '22023';
  END IF;
  IF p_decision NOT IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Decision must be APPROVED, REJECTED or CANCELLED.' USING ERRCODE = '22023';
  END IF;
  IF p_review_comment IS NOT NULL AND length(p_review_comment) > 2000 THEN
    RAISE EXCEPTION 'Review comment cannot exceed 2000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_correction_before
    FROM public.assessment_mark_corrections
   WHERE id = p_correction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment correction was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_correction_before.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Correction is already %.', v_correction_before.status USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_mark_before
    FROM public.assessment_marks
   WHERE id = v_correction_before.assessment_mark_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assessment mark was not found.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.assessment_mark_corrections
     SET status = p_decision,
         reviewed_by = p_actor_id,
         reviewed_at = now(),
         review_comment = p_review_comment,
         updated_at = now()
   WHERE id = p_correction_id AND status = 'PENDING'
   RETURNING * INTO v_correction_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction decision changed; reload and try again.' USING ERRCODE = '40001';
  END IF;

  v_mark_after := v_mark_before;
  IF p_decision = 'APPROVED' THEN
    IF v_mark_before.marks IS DISTINCT FROM v_correction_before.old_marks
       OR v_mark_before.grade IS DISTINCT FROM v_correction_before.old_grade THEN
      RAISE EXCEPTION 'Assessment mark changed since this correction was requested.' USING ERRCODE = '40001';
    END IF;
    SELECT maximum_marks INTO v_maximum_marks
      FROM public.assessments
     WHERE id = v_mark_before.assessment_id
     FOR UPDATE;
    IF NOT FOUND OR v_maximum_marks IS NULL OR v_maximum_marks <= 0 THEN
      RAISE EXCEPTION 'Assessment maximum marks are unavailable.' USING ERRCODE = '23514';
    END IF;
    IF v_correction_before.new_marks IS NULL OR v_correction_before.new_marks < 0 OR v_correction_before.new_marks > v_maximum_marks THEN
      RAISE EXCEPTION 'Corrected marks must be within the assessment maximum.' USING ERRCODE = '23514';
    END IF;

    PERFORM set_config('idmc.assessment_correction_rpc', 'on', true);
    UPDATE public.assessment_marks
       SET marks = v_correction_before.new_marks,
           percentage = round((v_correction_before.new_marks / v_maximum_marks) * 100, 4),
           grade = coalesce(v_correction_before.new_grade, grade),
           status = 'CORRECTION_PENDING',
           updated_at = now()
     WHERE id = v_mark_before.id
     RETURNING * INTO v_mark_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assessment mark could not be updated.' USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.audit_logs (
    user_id, action_code, module_code, entity_type, entity_id,
    old_values, new_values, ip_address, request_id
  ) VALUES (
    p_actor_id, 'ASSESSMENT_CORRECTION_DECIDE', 'ASSESSMENT',
    'assessment_mark_corrections', p_correction_id,
    jsonb_build_object('correction', to_jsonb(v_correction_before), 'mark', to_jsonb(v_mark_before)),
    jsonb_build_object('correction', to_jsonb(v_correction_after), 'mark', to_jsonb(v_mark_after)),
    p_ip_address, p_request_id
  );

  RETURN jsonb_build_object('correction', to_jsonb(v_correction_after), 'mark', to_jsonb(v_mark_after));
END;
$$;

REVOKE ALL ON FUNCTION public.decide_assessment_mark_correction_atomic(uuid, text, uuid, text, inet, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_assessment_mark_correction_atomic(uuid, text, uuid, text, inet, varchar) TO service_role;

COMMIT;
