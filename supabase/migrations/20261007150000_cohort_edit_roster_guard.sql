-- Serialize cohort edits with assignments so capacity and programme rules cannot race.
BEGIN;

CREATE OR REPLACE FUNCTION public.update_cohort_with_roster_guard(
  p_cohort_id uuid,
  p_institution_id uuid,
  p_payload jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.student_cohorts%ROWTYPE;
  v_after public.student_cohorts%ROWTYPE;
  v_roster_count bigint;
  v_programme_id uuid;
  v_programme_version_id uuid;
  v_capacity integer;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Cohort payload must be a JSON object.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_before
    FROM public.student_cohorts
   WHERE id = p_cohort_id AND institution_id = p_institution_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cohort not found.' USING ERRCODE = 'P0002'; END IF;

  v_programme_id := NULLIF(p_payload->>'programme_id', '')::uuid;
  v_programme_version_id := NULLIF(p_payload->>'programme_version_id', '')::uuid;
  v_capacity := NULLIF(p_payload->>'max_capacity', '')::integer;
  SELECT count(*) INTO v_roster_count
    FROM public.students
   WHERE cohort_id = p_cohort_id AND archived_at IS NULL;
  IF v_roster_count > 0 AND (
    v_before.programme_id IS DISTINCT FROM v_programme_id OR
    v_before.programme_version_id IS DISTINCT FROM v_programme_version_id
  ) THEN
    RAISE EXCEPTION 'Move assigned students before changing the cohort programme or version.' USING ERRCODE = '23514';
  END IF;
  IF v_capacity IS NOT NULL AND v_roster_count > v_capacity THEN
    RAISE EXCEPTION 'Capacity cannot be lower than the current roster of % students.', v_roster_count USING ERRCODE = '23514';
  END IF;

  UPDATE public.student_cohorts
     SET cohort_code = upper(p_payload->>'cohort_code'),
         cohort_name = p_payload->>'cohort_name',
         programme_id = v_programme_id,
         programme_version_id = v_programme_version_id,
         default_academic_year_id = NULLIF(p_payload->>'default_academic_year_id', '')::uuid,
         intake_code = upper(NULLIF(p_payload->>'intake_code', '')),
         intake_name = NULLIF(p_payload->>'intake_name', ''),
         entry_year = (p_payload->>'entry_year')::integer,
         start_date = NULLIF(p_payload->>'start_date', '')::date,
         expected_completion_date = NULLIF(p_payload->>'expected_completion_date', '')::date,
         study_mode = COALESCE(p_payload->>'study_mode', 'FULL_TIME'),
         campus_id = NULLIF(p_payload->>'campus_id', '')::uuid,
         max_capacity = v_capacity,
         status = COALESCE(p_payload->>'status', 'ACTIVE'),
         notes = NULLIF(p_payload->>'notes', ''),
         updated_by = p_actor_id,
         updated_at = now()
   WHERE id = p_cohort_id AND institution_id = p_institution_id
   RETURNING * INTO v_after;

  RETURN jsonb_build_object('old_values', to_jsonb(v_before), 'new_values', to_jsonb(v_after));
END;
$$;

REVOKE ALL ON FUNCTION public.update_cohort_with_roster_guard(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_cohort_with_roster_guard(uuid, uuid, jsonb, uuid) TO service_role;

COMMIT;
