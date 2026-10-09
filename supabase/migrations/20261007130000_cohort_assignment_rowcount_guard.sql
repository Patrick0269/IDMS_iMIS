-- Keep cohort assignment all-or-nothing if records change between validation and update.
BEGIN;

CREATE OR REPLACE FUNCTION public.assign_students_to_cohort(
  p_cohort_id uuid,
  p_student_ids uuid[],
  p_expected_current_cohort uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cohort public.student_cohorts%ROWTYPE;
  v_requested integer;
  v_existing integer;
  v_additional integer;
  v_changed integer;
BEGIN
  IF p_student_ids IS NULL OR cardinality(p_student_ids) < 1 OR cardinality(p_student_ids) > 200 THEN
    RAISE EXCEPTION 'Select between 1 and 200 students.' USING ERRCODE = '22023';
  END IF;
  SELECT count(DISTINCT x) INTO v_requested FROM unnest(p_student_ids) AS x;
  IF v_requested <> cardinality(p_student_ids) THEN
    RAISE EXCEPTION 'Duplicate student IDs are not allowed.' USING ERRCODE = '22023';
  END IF;

  IF p_cohort_id IS NULL THEN
    IF p_expected_current_cohort IS NULL THEN
      RAISE EXCEPTION 'Expected current cohort is required when removing students.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_cohort FROM public.student_cohorts WHERE id = p_expected_current_cohort;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cohort not found.' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.students
       SET cohort_id = NULL, updated_at = now()
     WHERE id = ANY(p_student_ids)
       AND cohort_id = p_expected_current_cohort
       AND institution_id = v_cohort.institution_id;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> v_requested THEN
      RAISE EXCEPTION 'One or more students are no longer in this cohort.' USING ERRCODE = '40001';
    END IF;
    RETURN v_changed;
  END IF;

  SELECT * INTO v_cohort FROM public.student_cohorts WHERE id = p_cohort_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cohort not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_cohort.status <> 'ACTIVE' THEN RAISE EXCEPTION 'Students can only be assigned to an active cohort.' USING ERRCODE = '23514'; END IF;
  SELECT count(*) INTO v_requested FROM public.students
   WHERE id = ANY(p_student_ids)
     AND institution_id = v_cohort.institution_id
     AND archived_at IS NULL;
  IF v_requested <> cardinality(p_student_ids) THEN RAISE EXCEPTION 'One or more students were not found or are archived.' USING ERRCODE = 'P0002'; END IF;
  SELECT count(*) INTO v_existing FROM public.students
   WHERE cohort_id = p_cohort_id
     AND institution_id = v_cohort.institution_id
     AND archived_at IS NULL;
  SELECT count(*) INTO v_additional FROM public.students
   WHERE id = ANY(p_student_ids) AND cohort_id IS DISTINCT FROM p_cohort_id
     AND institution_id = v_cohort.institution_id
     AND archived_at IS NULL;
  IF v_cohort.max_capacity IS NOT NULL AND v_existing + v_additional > v_cohort.max_capacity THEN
    RAISE EXCEPTION 'Cohort capacity would be exceeded (% of %).', v_existing + v_additional, v_cohort.max_capacity USING ERRCODE = '23514';
  END IF;
  -- Repeat the institution scope in the write to remain safe if a student's
  -- institution changes between validation and update.
  UPDATE public.students
     SET cohort_id = p_cohort_id,
         admission_year = v_cohort.entry_year,
         programme_id = COALESCE(programme_id, v_cohort.programme_id),
         programme_version_id = COALESCE(programme_version_id, v_cohort.programme_version_id),
         updated_at = now()
   WHERE id = ANY(p_student_ids)
     AND institution_id = v_cohort.institution_id;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> cardinality(p_student_ids) THEN
    RAISE EXCEPTION 'One or more students changed institution or became unavailable during assignment.' USING ERRCODE = '40001';
  END IF;
  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_students_to_cohort(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_students_to_cohort(uuid, uuid[], uuid) TO service_role;

COMMIT;
