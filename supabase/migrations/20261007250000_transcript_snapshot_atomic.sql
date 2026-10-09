-- Generate official transcript snapshots from approved academic records in one transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.generate_student_transcript_snapshot_atomic(
  p_transcript_id uuid,
  p_actor_id uuid,
  p_ip_address inet DEFAULT NULL,
  p_request_id varchar DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transcript public.student_transcripts%ROWTYPE;
  v_after public.student_transcripts%ROWTYPE;
  v_semesters integer;
  v_courses integer;
BEGIN
  SELECT * INTO v_transcript
    FROM public.student_transcripts
   WHERE id = p_transcript_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transcript not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_transcript.transcript_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only a DRAFT transcript can be generated; current status is %.', v_transcript.transcript_status USING ERRCODE = '23514';
  END IF;
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'An authenticated transcript officer is required.' USING ERRCODE = '22023'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.student_semester_results ssr
     WHERE ssr.student_id = v_transcript.student_id
       AND ssr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
  ) THEN
    RAISE EXCEPTION 'The student has no approved semester results to include.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.course_results cr
     WHERE cr.student_id = v_transcript.student_id
       AND cr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
  ) THEN
    RAISE EXCEPTION 'The student has no approved course results to include.' USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.student_transcript_courses WHERE transcript_id = p_transcript_id;
  DELETE FROM public.student_transcript_semesters WHERE transcript_id = p_transcript_id;

  INSERT INTO public.student_transcript_semesters (
    transcript_id, academic_year_id, semester_id, semester_result_id, gpa,
    registered_credits, attempted_credits, earned_credits, quality_points,
    academic_standing, sequence_no
  )
  SELECT p_transcript_id, ssr.academic_year_id, ssr.semester_id, ssr.id, ssr.gpa,
         ssr.total_registered_credits, ssr.total_attempted_credits,
         ssr.total_earned_credits, ssr.total_quality_points,
         ssr.academic_standing,
         row_number() OVER (ORDER BY ay.start_date, sem.semester_number, ay.year_code, sem.semester_code)::integer
    FROM public.student_semester_results ssr
    JOIN public.academic_years ay ON ay.id = ssr.academic_year_id
    JOIN public.semesters sem ON sem.id = ssr.semester_id AND sem.academic_year_id = ssr.academic_year_id
   WHERE ssr.student_id = v_transcript.student_id
     AND ssr.result_status IN ('APPROVED','PUBLISHED','LOCKED');
  GET DIAGNOSTICS v_semesters = ROW_COUNT;

  INSERT INTO public.student_transcript_courses (
    transcript_id, transcript_semester_id, course_result_id,
    course_registration_id, course_id, course_code, course_name, credits,
    coursework_mark, examination_mark, total_mark, grade_code, grade_point,
    result_type, attempt_number, pass_status, display_sequence
  )
  SELECT p_transcript_id, ts.id, cr.id, cr.course_registration_id, c.id,
         c.course_code, c.course_name, cr.credits, cr.coursework_mark,
         cr.examination_mark, cr.total_mark, cr.grade_code, cr.grade_point,
         cr.result_type, cr.attempt_number, cr.pass_status,
         row_number() OVER (
           PARTITION BY ts.id
           ORDER BY c.course_code, cr.attempt_number, cr.created_at, cr.id
         )::integer
    FROM public.course_results cr
    JOIN public.student_transcript_semesters ts
      ON ts.transcript_id = p_transcript_id
     AND ts.academic_year_id = cr.academic_year_id
     AND ts.semester_id = cr.semester_id
    JOIN public.course_offerings offering ON offering.id = cr.course_offering_id
    JOIN public.courses c ON c.id = offering.course_id
   WHERE cr.student_id = v_transcript.student_id
     AND cr.result_status IN ('APPROVED','PUBLISHED','LOCKED');
  GET DIAGNOSTICS v_courses = ROW_COUNT;
  IF v_semesters = 0 OR v_courses = 0 THEN
    RAISE EXCEPTION 'Approved transcript snapshot is empty; results may not share approved semesters.' USING ERRCODE = '23514';
  END IF;

  UPDATE public.student_transcripts t
     SET cumulative_credits = totals.registered,
         cumulative_earned_credits = totals.earned,
         cumulative_quality_points = totals.quality,
         cgpa = (
           SELECT COALESCE(ROUND(sum(cr.grade_point * cr.credits) / NULLIF(sum(cr.credits), 0), 3), 0)
             FROM public.course_results cr
            WHERE cr.student_id = v_transcript.student_id
              AND cr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
              AND cr.pass_status IS NOT NULL
              AND cr.pass_status NOT IN ('WITHHELD','INCOMPLETE')
         ),
         final_academic_standing = totals.final_standing,
         transcript_status = 'GENERATED',
         generated_at = now(), generated_by = p_actor_id, updated_at = now()
    FROM (
      SELECT COALESCE(sum(ssr.total_registered_credits), 0) AS registered,
             COALESCE(sum(ssr.total_earned_credits), 0) AS earned,
             COALESCE(sum(ssr.total_quality_points), 0) AS quality,
             (array_agg(ssr.academic_standing ORDER BY ay.start_date DESC, sem.semester_number DESC))[1] AS final_standing
        FROM public.student_semester_results ssr
        JOIN public.academic_years ay ON ay.id = ssr.academic_year_id
        JOIN public.semesters sem ON sem.id = ssr.semester_id AND sem.academic_year_id = ssr.academic_year_id
       WHERE ssr.student_id = v_transcript.student_id
         AND ssr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
    ) totals
   WHERE t.id = p_transcript_id
   RETURNING t.* INTO v_after;

  INSERT INTO public.audit_logs (
    user_id, action_code, module_code, entity_type, entity_id,
    old_values, new_values, ip_address, request_id
  ) VALUES (
    p_actor_id, 'TRANSCRIPT_GENERATE', 'TRANSCRIPTS', 'student_transcripts',
    p_transcript_id, to_jsonb(v_transcript),
    jsonb_build_object('transcript', to_jsonb(v_after), 'semester_count', v_semesters, 'course_count', v_courses),
    p_ip_address, p_request_id
  );

  RETURN jsonb_build_object('transcript', to_jsonb(v_after), 'semester_count', v_semesters, 'course_count', v_courses);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_student_transcript_snapshot_atomic(uuid, uuid, inet, varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_student_transcript_snapshot_atomic(uuid, uuid, inet, varchar) TO service_role;

COMMIT;
