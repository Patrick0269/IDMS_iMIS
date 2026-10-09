BEGIN;

-- Add eligible, academically registered students to shared courses so the
-- central course_registrations record feeds results, assessments, attendance,
-- examinations and student self-service consistently.
CREATE OR REPLACE FUNCTION public.idmc_sync_cross_cutting_course_roster(
  p_course_id uuid,
  p_academic_year_id uuid,
  p_semester_id uuid,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course public.courses%ROWTYPE;
  v_semester public.semesters%ROWTYPE;
  v_candidate record;
  v_offering_id uuid;
  v_existing public.course_registrations%ROWTYPE;
  v_now timestamptz := now();
  v_candidates integer := 0;
  v_registered_now integer := 0;
  v_already_registered integer := 0;
  v_skipped_prerequisites integer := 0;
  v_skipped_no_offering integer := 0;
  v_skipped_existing_terminal integer := 0;
  v_skipped_credits integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_course_id::text || p_academic_year_id::text || p_semester_id::text, 0));

  SELECT * INTO v_course
  FROM public.courses
  WHERE id = p_course_id AND status = 'ACTIVE' AND cross_cutting = true;
  IF v_course.id IS NULL THEN RAISE EXCEPTION 'Choose an active course marked as cross-cutting'; END IF;

  SELECT * INTO v_semester FROM public.semesters
  WHERE id = p_semester_id AND academic_year_id = p_academic_year_id;
  IF v_semester.id IS NULL THEN RAISE EXCEPTION 'Semester does not belong to the selected academic year'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.course_offerings co
    WHERE co.course_id = p_course_id AND co.academic_year_id = p_academic_year_id
      AND co.semester_id = p_semester_id AND co.status IN ('OPEN','CLOSED')
  ) THEN RAISE EXCEPTION 'Open a course offering for this academic year and semester before syncing students'; END IF;

  FOR v_candidate IN
    SELECT DISTINCT ON (sr.id)
      sr.id AS student_registration_id, sr.student_id, sr.programme_id,
      coalesce(sr.programme_version_id, st.programme_version_id) AS programme_version_id,
      coalesce(cc.credit_units, v_course.credit_units) AS credits,
      cc.is_compulsory, cc.curriculum_id
    FROM public.student_registrations sr
    JOIN public.students st ON st.id = sr.student_id AND st.student_status = 'ACTIVE'
    JOIN public.curricula cu
      ON cu.programme_version_id = coalesce(sr.programme_version_id, st.programme_version_id)
     AND cu.status = 'ACTIVE'
    JOIN public.curriculum_courses cc
      ON cc.curriculum_id = cu.id AND cc.course_id = p_course_id
     AND cc.semester_number = v_semester.semester_number
    WHERE sr.academic_year_id = p_academic_year_id AND sr.semester_id = p_semester_id
      AND sr.registration_status IN ('APPROVED','REGISTERED','LOCKED')
      AND sr.academic_eligibility_status IN ('ELIGIBLE','OVERRIDE')
    ORDER BY sr.id, cu.effective_from DESC NULLS LAST, cu.created_at DESC
  LOOP
    v_candidates := v_candidates + 1;
    IF coalesce(v_candidate.credits, 0) <= 0 THEN
      v_skipped_credits := v_skipped_credits + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.course_prerequisites cp
      WHERE cp.course_id = p_course_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.course_results cr
          JOIN public.course_offerings po ON po.id = cr.course_offering_id
          WHERE cr.student_id = v_candidate.student_id
            AND po.course_id = cp.prerequisite_course_id
            AND cr.pass_status = 'PASS'
            AND cr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
        )
    ) THEN
      v_skipped_prerequisites := v_skipped_prerequisites + 1;
      CONTINUE;
    END IF;

    SELECT co.id INTO v_offering_id
    FROM public.course_offerings co
    WHERE co.course_id = p_course_id AND co.academic_year_id = p_academic_year_id
      AND co.semester_id = p_semester_id AND co.status IN ('OPEN','CLOSED')
    ORDER BY (co.programme_id = v_candidate.programme_id) DESC,
             (co.programme_version_id = v_candidate.programme_version_id) DESC,
             (co.status = 'OPEN') DESC, co.created_at, co.id
    LIMIT 1;
    IF v_offering_id IS NULL THEN
      v_skipped_no_offering := v_skipped_no_offering + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM public.course_registrations cr
    WHERE cr.student_registration_id = v_candidate.student_registration_id
      AND cr.course_id = p_course_id
    ORDER BY cr.created_at DESC LIMIT 1 FOR UPDATE;

    IF v_existing.id IS NOT NULL AND v_existing.registration_status IN ('DROPPED','REJECTED','CANCELLED') THEN
      v_skipped_existing_terminal := v_skipped_existing_terminal + 1;
      CONTINUE;
    ELSIF v_existing.id IS NOT NULL AND v_existing.registration_status IN ('REGISTERED') THEN
      v_already_registered := v_already_registered + 1;
    ELSIF v_existing.id IS NOT NULL THEN
      UPDATE public.course_registrations SET
        course_offering_id = v_offering_id,
        credits = v_candidate.credits,
        registration_status = 'REGISTERED',
        is_core = v_candidate.is_compulsory,
        is_elective = NOT v_candidate.is_compulsory,
        prerequisite_status = CASE WHEN EXISTS (SELECT 1 FROM public.course_prerequisites WHERE course_id = p_course_id) THEN 'PASSED' ELSE 'NOT_REQUIRED' END,
        eligibility_status = 'ELIGIBLE', approved_at = v_now, approved_by = p_actor_id,
        updated_by = p_actor_id, updated_at = v_now
      WHERE id = v_existing.id;
      v_registered_now := v_registered_now + 1;
    ELSE
      INSERT INTO public.course_registrations (
        student_registration_id, student_id, course_id, course_offering_id,
        registration_type, credits, registration_status, is_core, is_elective,
        prerequisite_status, eligibility_status, selected_at, approved_at,
        approved_by, created_by, updated_by
      ) VALUES (
        v_candidate.student_registration_id, v_candidate.student_id, p_course_id, v_offering_id,
        'NORMAL', v_candidate.credits, 'REGISTERED', v_candidate.is_compulsory,
        NOT v_candidate.is_compulsory,
        CASE WHEN EXISTS (SELECT 1 FROM public.course_prerequisites WHERE course_id = p_course_id) THEN 'PASSED' ELSE 'NOT_REQUIRED' END,
        'ELIGIBLE', v_now, v_now, p_actor_id, p_actor_id, p_actor_id
      );
      v_registered_now := v_registered_now + 1;
    END IF;

    UPDATE public.student_registrations sr SET
      total_registered_credits = coalesce((
        SELECT sum(cr.credits) FROM public.course_registrations cr
        WHERE cr.student_registration_id = sr.id
          AND cr.registration_status NOT IN ('DROPPED','REJECTED','CANCELLED')
      ), 0), updated_by = p_actor_id, updated_at = v_now
    WHERE sr.id = v_candidate.student_registration_id;
  END LOOP;

  RETURN jsonb_build_object(
    'courseId', p_course_id, 'academicYearId', p_academic_year_id, 'semesterId', p_semester_id,
    'eligibleStudents', v_candidates, 'registeredNow', v_registered_now,
    'alreadyRegistered', v_already_registered, 'skippedPrerequisites', v_skipped_prerequisites,
    'skippedNoOffering', v_skipped_no_offering, 'skippedPreviouslyDropped', v_skipped_existing_terminal,
    'skippedInvalidCredits', v_skipped_credits
  );
END;
$$;

-- Keep future approved semester registrations in sync as well. The course
-- offering row is the shared key used by the downstream academic workspaces.
CREATE OR REPLACE FUNCTION public.idmc_sync_cross_cutting_courses_for_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student public.students%ROWTYPE;
  v_semester public.semesters%ROWTYPE;
  v_course record;
  v_offering_id uuid;
  v_existing public.course_registrations%ROWTYPE;
  v_actor_id uuid;
  v_now timestamptz := now();
BEGIN
  IF NEW.registration_status NOT IN ('APPROVED','REGISTERED','LOCKED')
     OR NEW.academic_eligibility_status NOT IN ('ELIGIBLE','OVERRIDE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.registration_status IS NOT DISTINCT FROM NEW.registration_status
     AND OLD.academic_eligibility_status IS NOT DISTINCT FROM NEW.academic_eligibility_status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_student FROM public.students
  WHERE id = NEW.student_id AND student_status = 'ACTIVE';
  IF v_student.id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_semester FROM public.semesters
  WHERE id = NEW.semester_id AND academic_year_id = NEW.academic_year_id;
  IF v_semester.id IS NULL THEN RETURN NEW; END IF;
  v_actor_id := coalesce(NEW.updated_by, NEW.approved_by, NEW.created_by);

  FOR v_course IN
    SELECT DISTINCT ON (c.id)
      c.id AS course_id, coalesce(cc.credit_units, c.credit_units) AS credits,
      cc.is_compulsory
    FROM public.curricula cu
    JOIN public.curriculum_courses cc ON cc.curriculum_id = cu.id
    JOIN public.courses c ON c.id = cc.course_id
    WHERE cu.programme_version_id = coalesce(NEW.programme_version_id, v_student.programme_version_id)
      AND cu.status = 'ACTIVE' AND cc.semester_number = v_semester.semester_number
      AND c.status = 'ACTIVE' AND c.cross_cutting = true
    ORDER BY c.id, cu.effective_from DESC NULLS LAST, cu.created_at DESC
  LOOP
    IF coalesce(v_course.credits, 0) <= 0 THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM public.course_prerequisites cp
      WHERE cp.course_id = v_course.course_id
        AND NOT EXISTS (
          SELECT 1 FROM public.course_results cr
          JOIN public.course_offerings po ON po.id = cr.course_offering_id
          WHERE cr.student_id = NEW.student_id AND po.course_id = cp.prerequisite_course_id
            AND cr.pass_status = 'PASS' AND cr.result_status IN ('APPROVED','PUBLISHED','LOCKED')
        )
    ) THEN CONTINUE; END IF;

    SELECT co.id INTO v_offering_id FROM public.course_offerings co
    WHERE co.course_id = v_course.course_id AND co.academic_year_id = NEW.academic_year_id
      AND co.semester_id = NEW.semester_id AND co.status IN ('OPEN','CLOSED')
    ORDER BY (co.programme_id = NEW.programme_id) DESC,
             (co.programme_version_id = coalesce(NEW.programme_version_id, v_student.programme_version_id)) DESC,
             (co.status = 'OPEN') DESC, co.created_at, co.id
    LIMIT 1;
    IF v_offering_id IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_existing FROM public.course_registrations cr
    WHERE cr.student_registration_id = NEW.id AND cr.course_id = v_course.course_id
    ORDER BY cr.created_at DESC LIMIT 1 FOR UPDATE;
    IF v_existing.id IS NOT NULL AND v_existing.registration_status IN ('DROPPED','REJECTED','CANCELLED','REGISTERED') THEN
      CONTINUE;
    ELSIF v_existing.id IS NOT NULL THEN
      UPDATE public.course_registrations SET
        course_offering_id = v_offering_id, credits = v_course.credits,
        registration_status = 'REGISTERED', is_core = v_course.is_compulsory,
        is_elective = NOT v_course.is_compulsory, eligibility_status = 'ELIGIBLE',
        prerequisite_status = CASE WHEN EXISTS (SELECT 1 FROM public.course_prerequisites WHERE course_id = v_course.course_id) THEN 'PASSED' ELSE 'NOT_REQUIRED' END,
        approved_at = v_now, approved_by = v_actor_id, updated_by = v_actor_id, updated_at = v_now
      WHERE id = v_existing.id;
    ELSE
      INSERT INTO public.course_registrations (
        student_registration_id, student_id, course_id, course_offering_id,
        registration_type, credits, registration_status, is_core, is_elective,
        prerequisite_status, eligibility_status, selected_at, approved_at,
        approved_by, created_by, updated_by
      ) VALUES (
        NEW.id, NEW.student_id, v_course.course_id, v_offering_id, 'NORMAL',
        v_course.credits, 'REGISTERED', v_course.is_compulsory, NOT v_course.is_compulsory,
        CASE WHEN EXISTS (SELECT 1 FROM public.course_prerequisites WHERE course_id = v_course.course_id) THEN 'PASSED' ELSE 'NOT_REQUIRED' END,
        'ELIGIBLE', v_now, v_now, v_actor_id, v_actor_id, v_actor_id
      );
    END IF;
  END LOOP;

  UPDATE public.student_registrations sr SET
    total_registered_credits = coalesce((
      SELECT sum(cr.credits) FROM public.course_registrations cr
      WHERE cr.student_registration_id = sr.id
        AND cr.registration_status NOT IN ('DROPPED','REJECTED','CANCELLED')
    ), 0), updated_at = v_now
  WHERE sr.id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cross_cutting_courses_for_registration ON public.student_registrations;
CREATE TRIGGER trg_sync_cross_cutting_courses_for_registration
AFTER INSERT OR UPDATE OF registration_status, academic_eligibility_status
ON public.student_registrations
FOR EACH ROW EXECUTE FUNCTION public.idmc_sync_cross_cutting_courses_for_registration();

-- Backfill existing approved registrations for currently active academic periods.
DO $$
DECLARE
  v_period record;
BEGIN
  FOR v_period IN
    SELECT DISTINCT co.course_id, co.academic_year_id, co.semester_id
    FROM public.course_offerings co
    JOIN public.courses c ON c.id = co.course_id AND c.status = 'ACTIVE' AND c.cross_cutting = true
    JOIN public.academic_years ay ON ay.id = co.academic_year_id AND ay.status = 'ACTIVE'
    JOIN public.semesters s ON s.id = co.semester_id AND s.status = 'ACTIVE'
    WHERE co.status IN ('OPEN','CLOSED')
  LOOP
    PERFORM public.idmc_sync_cross_cutting_course_roster(
      v_period.course_id, v_period.academic_year_id, v_period.semester_id, NULL
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.idmc_sync_cross_cutting_course_roster(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_sync_cross_cutting_courses_for_registration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_sync_cross_cutting_course_roster(uuid, uuid, uuid, uuid) TO service_role;

COMMIT;
