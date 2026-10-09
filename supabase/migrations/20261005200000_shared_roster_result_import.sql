BEGIN;

-- Resolve each imported result row against the exact programme offering the student registered for.
CREATE OR REPLACE FUNCTION public.validate_result_import_batch(p_batch_id uuid)
RETURNS public.result_import_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.result_import_rows%ROWTYPE;
    v_errors text[];
    v_student public.students%ROWTYPE;
    v_year public.academic_years%ROWTYPE;
    v_semester public.semesters%ROWTYPE;
    v_course public.courses%ROWTYPE;
    v_offering public.course_offerings%ROWTYPE;
    v_registration public.course_registrations%ROWTYPE;
    v_policy public.course_result_policies%ROWTYPE;
    v_existing_status text;
    v_duplicate_count integer;
    v_batch public.result_import_batches%ROWTYPE;
BEGIN
    UPDATE public.result_import_batches
    SET status = 'VALIDATING', failure_message = NULL
    WHERE id = p_batch_id;

    FOR r IN SELECT * FROM public.result_import_rows WHERE batch_id = p_batch_id ORDER BY row_number LOOP
        v_errors := '{}';
        v_student := NULL; v_year := NULL; v_semester := NULL; v_course := NULL;
        v_offering := NULL; v_registration := NULL; v_policy := NULL; v_existing_status := NULL;

        IF nullif(trim(r.regno), '') IS NULL THEN v_errors := array_append(v_errors, 'REGNO_MISSING'); END IF;
        IF nullif(trim(r.academic_year), '') IS NULL THEN v_errors := array_append(v_errors, 'ACADEMIC_YEAR_MISSING'); END IF;
        IF nullif(trim(r.semester), '') IS NULL THEN v_errors := array_append(v_errors, 'SEMESTER_MISSING'); END IF;
        IF nullif(trim(r.course_code), '') IS NULL THEN v_errors := array_append(v_errors, 'COURSE_CODE_MISSING'); END IF;
        IF r.coursework_mark IS NULL THEN v_errors := array_append(v_errors, 'COURSEWORK_MISSING'); END IF;
        IF r.examination_mark IS NULL THEN v_errors := array_append(v_errors, 'EXAMINATION_MISSING'); END IF;
        IF r.coursework_mark < 0 THEN v_errors := array_append(v_errors, 'COURSEWORK_BELOW_ZERO'); END IF;
        IF r.examination_mark < 0 THEN v_errors := array_append(v_errors, 'EXAMINATION_BELOW_ZERO'); END IF;
        IF r.result_type NOT IN ('NORMAL','SUPPLEMENTARY','SPECIAL','RESIT','RETAKE','REPEAT','CARRY_FORWARD','MAKEUP') THEN
            v_errors := array_append(v_errors, 'INVALID_RESULT_TYPE');
        END IF;

        SELECT count(*) INTO v_duplicate_count
        FROM public.result_import_rows d
        WHERE d.batch_id = p_batch_id
          AND lower(trim(d.regno)) = lower(trim(r.regno))
          AND lower(trim(d.academic_year)) = lower(trim(r.academic_year))
          AND lower(trim(d.semester)) = lower(trim(r.semester))
          AND lower(trim(d.course_code)) = lower(trim(r.course_code));
        IF v_duplicate_count > 1 THEN v_errors := array_append(v_errors, 'DUPLICATE_IN_FILE'); END IF;

        SELECT * INTO v_student FROM public.students s
        WHERE lower(s.student_number) = lower(trim(r.regno)) LIMIT 1;
        IF v_student.id IS NULL THEN
            v_errors := array_append(v_errors, 'UNKNOWN_REGNO');
        ELSIF v_student.student_status <> 'ACTIVE' THEN
            v_errors := array_append(v_errors, 'INACTIVE_STUDENT');
        END IF;

        SELECT * INTO v_year FROM public.academic_years ay
        WHERE lower(ay.year_code) = lower(trim(r.academic_year))
           OR lower(ay.year_name) = lower(trim(r.academic_year)) LIMIT 1;
        IF v_year.id IS NULL THEN v_errors := array_append(v_errors, 'UNKNOWN_ACADEMIC_YEAR'); END IF;

        IF v_year.id IS NOT NULL THEN
            SELECT * INTO v_semester FROM public.semesters s
            WHERE s.academic_year_id = v_year.id
              AND (lower(s.semester_code) = lower(trim(r.semester))
                OR lower(s.semester_name) = lower(trim(r.semester))) LIMIT 1;
        END IF;
        IF v_semester.id IS NULL THEN v_errors := array_append(v_errors, 'UNKNOWN_SEMESTER'); END IF;

        SELECT * INTO v_course FROM public.courses c
        WHERE lower(c.course_code) = lower(trim(r.course_code)) AND c.status = 'ACTIVE' LIMIT 1;
        IF v_course.id IS NULL THEN v_errors := array_append(v_errors, 'UNKNOWN_COURSE'); END IF;

        IF v_year.id IS NOT NULL AND v_semester.id IS NOT NULL AND v_course.id IS NOT NULL THEN
            SELECT * INTO v_offering FROM public.course_offerings co
            WHERE co.academic_year_id = v_year.id AND co.semester_id = v_semester.id
              AND co.course_id = v_course.id AND co.status <> 'CANCELLED' LIMIT 1;
        END IF;
        IF v_offering.id IS NULL THEN v_errors := array_append(v_errors, 'COURSE_NOT_OFFERED'); END IF;

        IF v_student.id IS NOT NULL AND v_offering.id IS NOT NULL THEN
            SELECT cr.* INTO v_registration
            FROM public.course_registrations cr
            JOIN public.course_offerings co ON co.id = cr.course_offering_id
            WHERE cr.student_id = v_student.id AND cr.course_id = v_course.id
              AND co.course_id = v_course.id AND co.academic_year_id = v_year.id
              AND co.semester_id = v_semester.id
              AND co.status <> 'CANCELLED'
              AND cr.registration_status NOT IN ('DROPPED','CANCELLED')
            ORDER BY CASE cr.registration_status WHEN 'APPROVED' THEN 0 WHEN 'REGISTERED' THEN 1 ELSE 2 END,
                     co.created_at, co.id
            LIMIT 1;
            IF v_registration.id IS NOT NULL THEN
                SELECT * INTO v_offering FROM public.course_offerings WHERE id = v_registration.course_offering_id;
            END IF;
        END IF;
        IF v_registration.id IS NULL THEN v_errors := array_append(v_errors, 'STUDENT_NOT_REGISTERED_FOR_COURSE'); END IF;

        IF v_offering.id IS NOT NULL THEN
            SELECT * INTO v_policy FROM public.course_result_policies p
            WHERE p.course_offering_id = v_offering.id AND p.status IN ('ACTIVE','LOCKED') LIMIT 1;
        END IF;
        IF v_policy.id IS NULL THEN
            v_errors := array_append(v_errors, 'RESULT_POLICY_MISSING');
        ELSE
            IF r.coursework_mark > v_policy.coursework_weight THEN v_errors := array_append(v_errors, 'COURSEWORK_ABOVE_MAXIMUM'); END IF;
            IF r.examination_mark > v_policy.examination_weight THEN v_errors := array_append(v_errors, 'EXAMINATION_ABOVE_MAXIMUM'); END IF;
        END IF;

        IF v_student.id IS NOT NULL AND v_offering.id IS NOT NULL AND v_registration.id IS NOT NULL THEN
            SELECT cr.result_status INTO v_existing_status FROM public.course_results cr
            WHERE cr.student_id = v_student.id AND cr.course_offering_id = v_offering.id
              AND cr.course_registration_id = v_registration.id LIMIT 1;
        END IF;
        IF v_existing_status IS NOT NULL AND v_existing_status NOT IN ('DRAFT','CALCULATED') THEN
            v_errors := array_append(v_errors, 'EXISTING_RESULT_REQUIRES_CORRECTION');
        END IF;

        UPDATE public.result_import_rows SET
            validation_status = CASE WHEN cardinality(v_errors) = 0 THEN 'VALID' ELSE 'INVALID' END,
            error_codes = v_errors,
            error_message = CASE WHEN cardinality(v_errors) = 0 THEN NULL ELSE array_to_string(v_errors, ', ') END,
            student_id = v_student.id, academic_year_id = v_year.id, semester_id = v_semester.id,
            course_id = v_course.id, course_offering_id = v_offering.id,
            course_registration_id = v_registration.id, credits = v_registration.credits
        WHERE id = r.id;
    END LOOP;

    UPDATE public.result_import_batches b SET
        status = 'VALIDATED', validated_at = now(),
        total_rows = (SELECT count(*) FROM public.result_import_rows WHERE batch_id = p_batch_id),
        valid_rows = (SELECT count(*) FROM public.result_import_rows WHERE batch_id = p_batch_id AND validation_status = 'VALID'),
        invalid_rows = (SELECT count(*) FROM public.result_import_rows WHERE batch_id = p_batch_id AND validation_status = 'INVALID'),
        duplicate_rows = (SELECT count(*) FROM public.result_import_rows WHERE batch_id = p_batch_id AND 'DUPLICATE_IN_FILE' = ANY(error_codes))
    WHERE b.id = p_batch_id RETURNING * INTO v_batch;
    RETURN v_batch;
END;
$$;

COMMIT;
