-- Finalize the registration, activate the student and write audit history atomically.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_student_registration_atomic(
  p_registration_id uuid,
  p_actor_id uuid,
  p_ip_address inet DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_registration_before public.student_registrations%ROWTYPE;
  v_registration_after public.student_registrations%ROWTYPE;
  v_student_before public.students%ROWTYPE;
  v_student_after public.students%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated registration officer is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_registration_before
    FROM public.student_registrations
   WHERE id = p_registration_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student registration was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF upper(coalesce(v_registration_before.registration_status, '')) NOT IN ('APPROVED', 'REGISTERED') THEN
    RAISE EXCEPTION 'Registration must be approved before final registration; current status is %.', v_registration_before.registration_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_student_before
    FROM public.students
   WHERE id = v_registration_before.student_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Registered student record was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF upper(coalesce(v_student_before.student_status, '')) NOT IN ('PENDING_ACTIVATION', 'ACTIVE') THEN
    RAISE EXCEPTION 'Student status is %; Admissions must activate the student before registration.', v_student_before.student_status USING ERRCODE = '23514';
  END IF;

  IF upper(v_registration_before.registration_status) = 'APPROVED' THEN
    UPDATE public.student_registrations
       SET registration_status = 'REGISTERED', updated_by = p_actor_id, updated_at = now()
     WHERE id = p_registration_id
     RETURNING * INTO v_registration_after;
  ELSE
    v_registration_after := v_registration_before;
  END IF;

  IF upper(v_student_before.student_status) = 'PENDING_ACTIVATION' THEN
    UPDATE public.students
       SET student_status = 'ACTIVE',
           activated_at = now(),
           enrollment_date = coalesce(v_student_before.enrollment_date, current_date),
           updated_at = now()
     WHERE id = v_student_before.id
     RETURNING * INTO v_student_after;
  ELSE
    v_student_after := v_student_before;
  END IF;

  IF upper(v_registration_before.registration_status) = 'APPROVED'
     OR upper(v_student_before.student_status) = 'PENDING_ACTIVATION' THEN
    INSERT INTO public.audit_logs (
      user_id, action_code, module_code, entity_type, entity_id,
      old_values, new_values, ip_address, request_id
    ) VALUES (
      p_actor_id, 'REGISTRATION_REGISTER', 'REGISTRATION',
      'student_registrations', p_registration_id,
      jsonb_build_object('registration', to_jsonb(v_registration_before), 'student', to_jsonb(v_student_before)),
      jsonb_build_object('registration', to_jsonb(v_registration_after), 'student', to_jsonb(v_student_after)),
      p_ip_address, p_request_id
    );
  END IF;

  RETURN jsonb_build_object('registration', to_jsonb(v_registration_after), 'student', to_jsonb(v_student_after));
END;
$$;

REVOKE ALL ON FUNCTION public.register_student_registration_atomic(uuid, uuid, inet, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_student_registration_atomic(uuid, uuid, inet, varchar) TO service_role;

COMMIT;
