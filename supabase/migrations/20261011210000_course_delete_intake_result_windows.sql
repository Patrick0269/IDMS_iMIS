BEGIN;

-- Result-window rows reference course_offerings and must be included in the
-- reviewed, backed-up dependency plan when an administrator deletes a course.
-- Without this table in the allowlist, course deletion stops before changing
-- any data with "outside the course reset scope".
CREATE OR REPLACE FUNCTION public.idmc_course_force_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path=''
AS $$
  SELECT ARRAY[
    'public.courses',
    'public.curriculum_courses',
    'public.course_prerequisites',
    'public.course_offerings',
    'public.course_registrations',
    'public.course_add_drop_requests',
    'public.classes',
    'public.class_students',
    'public.lecturer_assignments',
    'public.timetable_entries',
    'public.attendance_sessions',
    'public.attendance_records',
    'public.attendance_corrections',
    'public.assessments',
    'public.assessment_marks',
    'public.assessment_submissions',
    'public.assessment_mark_corrections',
    'public.examination_papers',
    'public.examination_candidates',
    'public.examination_sessions',
    'public.examination_invigilators',
    'public.examination_attendance',
    'public.examination_marks',
    'public.examination_mark_corrections',
    'public.course_result_policies',
    'public.course_results',
    'public.course_result_corrections',
    'public.result_import_rows',
    'public.student_course_attempts',
    'public.student_academic_deficiencies',
    'public.student_transcript_courses',
    'public.student_transcript_semesters',
    'public.student_semester_results',
    'public.student_gpa_records',
    'public.student_cgpa_records',
    'public.student_academic_standings',
    'public.clinical_placements',
    'public.clinical_assessments',
    'public.field_practicals',
    'public.field_practical_reports',
    'public.student_coursework_responses',
    'public.student_course_evaluations',
    'public.idmc_result_windows',
    'public.idmc_intake_result_windows',
    'public.idmc_result_comments',
    'public.academic_records',
    'public.examination_candidate_sessions',
    'public.placement_logbook_entries',
    'public.historical_academic_import_rows'
  ]::text[];
$$;

REVOKE ALL ON FUNCTION public.idmc_course_force_tables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_tables() TO service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
