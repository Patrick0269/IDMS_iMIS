-- Complete cohort management foundation. Additive and safe for existing records.
BEGIN;

ALTER TABLE public.student_cohorts
  ADD COLUMN IF NOT EXISTS programme_id uuid REFERENCES public.programmes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS programme_version_id uuid REFERENCES public.programme_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS intake_code varchar(30),
  ADD COLUMN IF NOT EXISTS intake_name varchar(80),
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS expected_completion_date date,
  ADD COLUMN IF NOT EXISTS study_mode varchar(30) NOT NULL DEFAULT 'FULL_TIME',
  ADD COLUMN IF NOT EXISTS campus_id uuid REFERENCES public.campuses(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS max_capacity integer,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- Multiple programmes/intakes may begin in the same year; cohort_code remains
-- institution-unique and is the stable duplicate-prevention key.
ALTER TABLE public.student_cohorts
  DROP CONSTRAINT IF EXISTS student_cohorts_institution_id_entry_year_key;
ALTER TABLE public.student_cohorts
  DROP CONSTRAINT IF EXISTS student_cohorts_status_check;
ALTER TABLE public.student_cohorts
  ADD CONSTRAINT student_cohorts_status_check
  CHECK (status IN ('ACTIVE','INACTIVE','CLOSED','ARCHIVED'));
ALTER TABLE public.student_cohorts
  ADD CONSTRAINT student_cohorts_dates_check
  CHECK (expected_completion_date IS NULL OR start_date IS NULL OR expected_completion_date >= start_date);
ALTER TABLE public.student_cohorts
  ADD CONSTRAINT student_cohorts_capacity_check
  CHECK (max_capacity IS NULL OR max_capacity > 0);
ALTER TABLE public.student_cohorts
  ADD CONSTRAINT student_cohorts_study_mode_check
  CHECK (study_mode IN ('FULL_TIME','PART_TIME','DISTANCE','BLENDED','EVENING','OTHER'));

CREATE INDEX IF NOT EXISTS idx_student_cohorts_programme_year
  ON public.student_cohorts (programme_id, entry_year, status);
CREATE INDEX IF NOT EXISTS idx_student_cohorts_intake
  ON public.student_cohorts (intake_code, entry_year);
CREATE INDEX IF NOT EXISTS idx_students_cohort_active
  ON public.students (cohort_id, student_status) WHERE archived_at IS NULL;

-- Assignment is atomic and capacity-safe under concurrent requests. Only the
-- server service role may call this function; API authorization is required.
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
  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_students_to_cohort(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_students_to_cohort(uuid, uuid[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_cohort_student_counts(p_cohort_ids uuid[])
RETURNS TABLE(cohort_id uuid, student_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.cohort_id, count(*)::bigint
    FROM public.students s
   WHERE s.cohort_id = ANY(p_cohort_ids) AND s.archived_at IS NULL
   GROUP BY s.cohort_id;
$$;
REVOKE ALL ON FUNCTION public.get_cohort_student_counts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cohort_student_counts(uuid[]) TO service_role;

INSERT INTO public.permissions(permission_code, permission_name, module_code, action_code, description, status)
VALUES
 ('cohorts.view','View cohorts and rosters','cohorts','view','View cohort records, filters and rosters','ACTIVE'),
 ('cohorts.manage','Manage cohorts and student assignments','cohorts','manage','Create, update, activate, transfer and export cohorts','ACTIVE')
ON CONFLICT (permission_code) DO UPDATE
SET permission_name=EXCLUDED.permission_name, description=EXCLUDED.description, status='ACTIVE', updated_at=now();

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('SUPER_ADMIN','ADMIN','REGISTRAR','ACADEMIC_OFFICER')
  AND p.permission_code IN ('cohorts.view','cohorts.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('LECTURER','HOD') AND p.permission_code='cohorts.view'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
