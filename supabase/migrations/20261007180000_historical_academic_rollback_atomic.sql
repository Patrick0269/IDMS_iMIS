-- Cancel an academic import, refresh its derived GPA/CGPA records, and audit
-- the operation as one transaction so a failed recalculation cannot leave a
-- batch rolled back while published summaries still include its attempts.
BEGIN;

CREATE OR REPLACE FUNCTION public.rollback_historical_academic_import(
  p_batch_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL,
  p_ip_address inet DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.historical_academic_import_batches%ROWTYPE;
  v_updated public.historical_academic_import_batches%ROWTYPE;
  v_row record;
  v_period record;
  v_student_id uuid;
  v_programme_version_id uuid;
  v_credits numeric(10,2);
  v_earned numeric(10,2);
  v_points numeric(12,3);
  v_gpa numeric(6,3);
  v_cgpa numeric(6,3);
  v_courses integer;
  v_passed integer;
  v_failed integer;
  v_cumulative_credits numeric(10,2);
  v_cumulative_earned numeric(10,2);
  v_cumulative_points numeric(12,3);
  v_period_count integer;
  v_attempt_count bigint;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A rollback reason is required.' USING ERRCODE = '22023';
  END IF;
  IF length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Rollback reason must be 2,000 characters or fewer.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_batch
    FROM public.historical_academic_import_batches
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Historical academic import batch was not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') THEN
    RAISE EXCEPTION 'Only a completed academic batch can be rolled back.' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.historical_academic_import_rows r
      LEFT JOIN public.student_course_attempts a
        ON a.id = r.course_attempt_id AND a.academic_import_batch_id = p_batch_id
     WHERE r.batch_id = p_batch_id
       AND r.validation_status = 'IMPORTED'
       AND a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'An imported row is not linked to an attempt in this batch; reconcile before rollback.' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_attempt_count
    FROM public.student_course_attempts
   WHERE academic_import_batch_id = p_batch_id
     AND attempt_status <> 'CANCELLED';
  IF v_attempt_count = 0 THEN
    RAISE EXCEPTION 'This academic batch has no active imported attempts to roll back.' USING ERRCODE = '23514';
  END IF;

  UPDATE public.student_course_attempts
     SET attempt_status = 'CANCELLED',
         remarks = concat_ws(E'\n', NULLIF(remarks, ''), format('Rolled back: %s', btrim(p_reason))),
         updated_at = now()
   WHERE academic_import_batch_id = p_batch_id
     AND attempt_status <> 'CANCELLED';

  UPDATE public.historical_academic_import_rows
     SET validation_status = 'ROLLED_BACK', updated_at = now()
   WHERE batch_id = p_batch_id AND validation_status = 'IMPORTED';

  UPDATE public.historical_academic_import_batches
     SET status = 'ROLLED_BACK', rolled_back_by = p_actor_id,
         rolled_back_at = now(), rollback_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_batch_id
   RETURNING * INTO v_updated;

  -- Match recalculateStudent(): include all still-published/locked attempts
  -- and retain previously generated historical periods even when now empty.
  FOR v_student_id IN
    SELECT DISTINCT student_id
      FROM public.student_course_attempts
     WHERE academic_import_batch_id = p_batch_id
  LOOP
    PERFORM 1 FROM public.students WHERE id = v_student_id FOR UPDATE;
    SELECT programme_version_id INTO v_programme_version_id
      FROM public.students WHERE id = v_student_id;
    v_cumulative_credits := 0;
    v_cumulative_earned := 0;
    v_cumulative_points := 0;
    v_period_count := 0;

    FOR v_period IN
      SELECT periods.academic_year_id, periods.semester_id
        FROM (
          SELECT academic_year_id, semester_id
            FROM public.student_course_attempts
           WHERE student_id = v_student_id AND attempt_status IN ('PUBLISHED', 'LOCKED')
          UNION
          SELECT academic_year_id, semester_id
            FROM public.student_semester_results
           WHERE student_id = v_student_id
             AND remarks = 'Centralized calculation from historical course attempts'
        ) periods
        JOIN public.academic_years y ON y.id = periods.academic_year_id
        JOIN public.semesters s ON s.id = periods.semester_id
       ORDER BY y.start_date, s.semester_number
    LOOP
      SELECT count(*)::integer,
             coalesce(sum(credits), 0),
             coalesce(sum(credits) FILTER (WHERE pass_status = 'PASS'), 0),
             coalesce(sum(coalesce(grade_point, 0) * credits), 0),
             count(*) FILTER (WHERE pass_status = 'PASS')::integer,
             count(*) FILTER (WHERE pass_status = 'FAIL')::integer
        INTO v_courses, v_credits, v_earned, v_points, v_passed, v_failed
        FROM public.student_course_attempts
       WHERE student_id = v_student_id
         AND academic_year_id = v_period.academic_year_id
         AND semester_id = v_period.semester_id
         AND attempt_status IN ('PUBLISHED', 'LOCKED');

      v_gpa := CASE WHEN v_credits > 0 THEN round(v_points / v_credits, 3) ELSE 0 END;
      v_cumulative_credits := v_cumulative_credits + v_credits;
      v_cumulative_earned := v_cumulative_earned + v_earned;
      v_cumulative_points := v_cumulative_points + v_points;
      v_cgpa := CASE WHEN v_cumulative_credits > 0 THEN round(v_cumulative_points / v_cumulative_credits, 3) ELSE 0 END;
      v_period_count := v_period_count + 1;

      INSERT INTO public.student_semester_results(
        student_id, academic_year_id, semester_id, programme_version_id,
        total_registered_credits, total_attempted_credits, total_earned_credits,
        total_quality_points, gpa, courses_attempted, courses_passed, courses_failed,
        academic_standing, result_status, calculated_at, remarks
      ) VALUES (
        v_student_id, v_period.academic_year_id, v_period.semester_id, v_programme_version_id,
        v_credits, v_credits, v_earned, v_points, v_gpa, v_courses, v_passed, v_failed,
        CASE WHEN v_courses = 0 THEN 'NO_ACTIVE_ATTEMPTS'
             WHEN v_cgpa >= 2 THEN 'GOOD'
             WHEN v_cgpa >= 1.5 THEN 'PROBATION'
             ELSE 'ACADEMIC_REVIEW' END,
        CASE WHEN v_courses = 0 THEN 'WITHHELD' ELSE 'LOCKED' END,
        now(), 'Centralized calculation from historical course attempts'
      ) ON CONFLICT (student_id, academic_year_id, semester_id) DO UPDATE SET
        programme_version_id = EXCLUDED.programme_version_id,
        total_registered_credits = EXCLUDED.total_registered_credits,
        total_attempted_credits = EXCLUDED.total_attempted_credits,
        total_earned_credits = EXCLUDED.total_earned_credits,
        total_quality_points = EXCLUDED.total_quality_points,
        gpa = EXCLUDED.gpa, courses_attempted = EXCLUDED.courses_attempted,
        courses_passed = EXCLUDED.courses_passed, courses_failed = EXCLUDED.courses_failed,
        academic_standing = EXCLUDED.academic_standing, result_status = EXCLUDED.result_status,
        calculated_at = EXCLUDED.calculated_at, remarks = EXCLUDED.remarks, updated_at = now();

      INSERT INTO public.student_gpa_records(
        student_id, academic_year_id, semester_id, semester_result_id,
        gpa, total_credits, total_quality_points, calculation_version, calculated_at
      ) SELECT v_student_id, v_period.academic_year_id, v_period.semester_id, sr.id,
               v_gpa, v_credits, v_points, 'HISTORICAL-1.0', now()
          FROM public.student_semester_results sr
         WHERE sr.student_id = v_student_id
           AND sr.academic_year_id = v_period.academic_year_id
           AND sr.semester_id = v_period.semester_id
      ON CONFLICT (student_id, academic_year_id, semester_id) DO UPDATE SET
        semester_result_id = EXCLUDED.semester_result_id, gpa = EXCLUDED.gpa,
        total_credits = EXCLUDED.total_credits, total_quality_points = EXCLUDED.total_quality_points,
        calculation_version = EXCLUDED.calculation_version, calculated_at = EXCLUDED.calculated_at;

      INSERT INTO public.student_cgpa_records(
        student_id, academic_year_id, semester_id, cumulative_credits,
        cumulative_earned_credits, cumulative_quality_points, cgpa,
        calculation_version, calculated_at
      ) VALUES (
        v_student_id, v_period.academic_year_id, v_period.semester_id, v_cumulative_credits,
        v_cumulative_earned, v_cumulative_points, v_cgpa, 'HISTORICAL-1.0', now()
      ) ON CONFLICT (student_id, academic_year_id, semester_id) DO UPDATE SET
        cumulative_credits = EXCLUDED.cumulative_credits,
        cumulative_earned_credits = EXCLUDED.cumulative_earned_credits,
        cumulative_quality_points = EXCLUDED.cumulative_quality_points,
        cgpa = EXCLUDED.cgpa, calculation_version = EXCLUDED.calculation_version,
        calculated_at = EXCLUDED.calculated_at;
    END LOOP;
  END LOOP;

  INSERT INTO public.audit_logs(
    user_id, action_code, module_code, entity_type, entity_id,
    old_values, new_values, ip_address, request_id
  ) VALUES (
    p_actor_id, 'HISTORICAL_ACADEMIC_ROLLBACK', 'historical_academics',
    'historical_academic_import_batch', p_batch_id, to_jsonb(v_batch), to_jsonb(v_updated),
    p_ip_address, NULLIF(p_request_id, '')
  );

  RETURN to_jsonb(v_updated) || jsonb_build_object('recalculated_students',
    (SELECT count(DISTINCT student_id) FROM public.student_course_attempts WHERE academic_import_batch_id = p_batch_id));
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_historical_academic_import(uuid, uuid, text, text, inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_historical_academic_import(uuid, uuid, text, text, inet) TO service_role;

COMMIT;
