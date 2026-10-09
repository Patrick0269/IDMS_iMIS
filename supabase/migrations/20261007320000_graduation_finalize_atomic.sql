-- Finalize graduation, award, certificate, student lifecycle and audit atomically.
BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_graduation_atomic(
  p_candidate_id uuid,
  p_actor_id uuid,
  p_verification_code varchar,
  p_alumni_suffix varchar,
  p_notification_number varchar,
  p_ip_address inet DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate public.graduation_candidates%ROWTYPE;
  v_student public.students%ROWTYPE;
  v_award public.graduation_awards%ROWTYPE;
  v_certificate public.certificates%ROWTYPE;
  v_alumni public.alumni_records%ROWTYPE;
  v_programme_name text;
  v_graduation_date date;
  v_year integer;
  v_certificate_number text;
  v_alumni_number text;
  v_clearance_count integer;
  v_approval_count integer;
  v_candidate_before public.graduation_candidates%ROWTYPE;
  v_student_before public.students%ROWTYPE;
  v_required_clearances text[] := ARRAY['ACADEMIC','FINANCE','LIBRARY','HOSTEL','DEPARTMENT','EXAMINATION','DISCIPLINE','DOCUMENTS'];
  v_required_approvals text[] := ARRAY['DEPARTMENT','HOD','ACADEMIC','EXAMINATION','REGISTRAR','MANAGEMENT'];
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'An authenticated graduation officer is required.' USING ERRCODE = '22023'; END IF;
  IF p_verification_code IS NULL OR length(btrim(p_verification_code)) < 16 THEN RAISE EXCEPTION 'A valid certificate verification code is required.' USING ERRCODE = '22023'; END IF;
  IF p_alumni_suffix IS NULL OR p_alumni_suffix !~ '^[0-9]{6}$' OR p_notification_number IS NULL OR length(btrim(p_notification_number)) = 0 THEN
    RAISE EXCEPTION 'A six-digit alumni suffix and notification number are required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_candidate FROM public.graduation_candidates WHERE id=p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Graduation candidate was not found.' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_student FROM public.students WHERE id=v_candidate.student_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Graduating student was not found.' USING ERRCODE = 'P0002'; END IF;
  v_candidate_before := v_candidate;
  v_student_before := v_student;

  IF v_candidate.candidate_status = 'GRADUATED' THEN
    SELECT * INTO v_award FROM public.graduation_awards WHERE graduation_candidate_id=p_candidate_id;
    SELECT * INTO v_certificate FROM public.certificates WHERE graduation_award_id=v_award.id ORDER BY created_at DESC LIMIT 1;
    SELECT * INTO v_alumni FROM public.alumni_records WHERE student_id=v_student.id;
    IF v_award.id IS NULL OR v_certificate.id IS NULL OR v_alumni.id IS NULL THEN RAISE EXCEPTION 'Graduation records are incomplete; contact Registry.' USING ERRCODE = '23514'; END IF;
    RETURN jsonb_build_object('candidate',to_jsonb(v_candidate),'award',to_jsonb(v_award),'certificate',to_jsonb(v_certificate),'alumni',to_jsonb(v_alumni));
  END IF;

  IF v_candidate.eligibility_status <> 'ELIGIBLE' OR v_candidate.academic_completion_status <> 'COMPLETE' THEN
    RAISE EXCEPTION 'Candidate must be eligible and academically complete.' USING ERRCODE = '23514';
  END IF;
  IF v_candidate.candidate_status NOT IN ('PENDING','CLEARED','APPROVED') THEN
    RAISE EXCEPTION 'Candidate cannot be graduated from status %.',v_candidate.candidate_status USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_clearance_count FROM public.graduation_clearances
   WHERE graduation_candidate_id=p_candidate_id AND clearance_type=ANY(v_required_clearances) AND status IN ('CLEARED','WAIVED');
  IF v_clearance_count <> cardinality(v_required_clearances) THEN RAISE EXCEPTION 'All required graduation clearances must be cleared or waived.' USING ERRCODE = '23514'; END IF;

  SELECT count(*) INTO v_approval_count FROM public.graduation_approvals
   WHERE graduation_candidate_id=p_candidate_id AND approval_stage=ANY(v_required_approvals) AND decision='APPROVED';
  IF v_approval_count <> cardinality(v_required_approvals) THEN RAISE EXCEPTION 'All required graduation approvals must be approved.' USING ERRCODE = '23514'; END IF;

  SELECT gp.graduation_date,p.programme_name INTO v_graduation_date,v_programme_name
    FROM public.graduation_periods gp CROSS JOIN public.programmes p
   WHERE gp.id=v_candidate.graduation_period_id AND p.id=v_candidate.programme_id;
  IF NOT FOUND OR v_graduation_date IS NULL THEN RAISE EXCEPTION 'Graduation period or programme is unavailable.' USING ERRCODE = '23514'; END IF;
  v_year := extract(year FROM v_graduation_date)::integer;
  v_certificate_number := 'IDMS/'||v_year::text||'/'||right(regexp_replace(v_student.student_number,'\W','','g'),8);
  v_alumni_number := 'IDMS/ALUMNI/'||v_year::text||'/'||p_alumni_suffix;

  INSERT INTO public.graduation_awards(graduation_candidate_id,award_name,award_classification,final_cgpa,graduation_date,certificate_number)
  VALUES(p_candidate_id,coalesce(v_programme_name,'Academic Award'),v_candidate.award_classification,v_candidate.final_cgpa,v_graduation_date,v_certificate_number)
  ON CONFLICT(graduation_candidate_id) DO UPDATE SET graduation_candidate_id=EXCLUDED.graduation_candidate_id
  RETURNING * INTO v_award;

  SELECT * INTO v_certificate FROM public.certificates WHERE graduation_award_id=v_award.id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.certificates(graduation_award_id,student_id,certificate_number,award_name,programme_id,programme_version_id,issue_date,verification_code,status,issued_by,issued_at)
    VALUES(v_award.id,v_student.id,v_certificate_number,v_award.award_name,v_candidate.programme_id,v_candidate.programme_version_id,v_graduation_date,p_verification_code,'ISSUED',p_actor_id,now())
    RETURNING * INTO v_certificate;
  END IF;

  SELECT * INTO v_alumni FROM public.alumni_records WHERE student_id=v_student.id FOR UPDATE;
  IF FOUND THEN
    IF v_alumni.graduation_candidate_id IS DISTINCT FROM p_candidate_id THEN RAISE EXCEPTION 'Student already has a different alumni record.' USING ERRCODE = '23505'; END IF;
  ELSE
    INSERT INTO public.alumni_records(student_id,graduation_candidate_id,graduation_award_id,alumni_number,graduation_year,email,phone,status)
    VALUES(v_student.id,p_candidate_id,v_award.id,v_alumni_number,v_year,v_student.email,v_student.phone,'ACTIVE')
    RETURNING * INTO v_alumni;
  END IF;

  UPDATE public.graduation_candidates SET candidate_status='GRADUATED',approved_by=coalesce(approved_by,p_actor_id),approved_at=coalesce(approved_at,now()),updated_at=now()
   WHERE id=p_candidate_id RETURNING * INTO v_candidate;
  UPDATE public.students SET student_status='GRADUATED',graduated_at=coalesce(graduated_at,now()),actual_completion_date=coalesce(actual_completion_date,v_graduation_date),updated_at=now()
   WHERE id=v_student.id RETURNING * INTO v_student;

  INSERT INTO public.student_lifecycle_events(student_id,event_type,entity_type,entity_id,previous_state,new_state,actor_user_id,event_data)
  VALUES(v_student.id,'GRADUATED_AND_ALUMNI_CREATED','graduation_candidate',p_candidate_id,v_student_before.student_status,'GRADUATED',p_actor_id,jsonb_build_object('certificate_id',v_certificate.id,'alumni_id',v_alumni.id));
  INSERT INTO public.notifications(notification_number,recipient_student_id,recipient_user_id,notification_type,title,body,priority,status,metadata)
  VALUES(p_notification_number,v_student.id,v_student.user_id,'GRADUATION','Graduation completed','Your graduation has been approved. Alumni number: '||v_alumni.alumni_number,'HIGH','PENDING',jsonb_build_object('certificate_number',v_certificate.certificate_number));
  INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values,ip_address,request_id)
  VALUES(p_actor_id,'GRADUATION_FINALIZE','GRADUATION','graduation_candidates',p_candidate_id,
    jsonb_build_object('candidate',to_jsonb(v_candidate_before),'student',to_jsonb(v_student_before)),
    jsonb_build_object('award',to_jsonb(v_award),'certificate',to_jsonb(v_certificate),'alumni',to_jsonb(v_alumni)),p_ip_address,p_request_id);

  RETURN jsonb_build_object('candidate',to_jsonb(v_candidate),'award',to_jsonb(v_award),'certificate',to_jsonb(v_certificate),'alumni',to_jsonb(v_alumni));
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_graduation_atomic(uuid,uuid,varchar,varchar,varchar,inet,varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_graduation_atomic(uuid,uuid,varchar,varchar,varchar,inet,varchar) TO service_role;

COMMIT;
