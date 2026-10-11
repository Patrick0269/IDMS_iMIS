BEGIN;

-- Locked coursework policies must stay immutable through normal application
-- operations. The audited, service-role-only admin reset is the sole exception.
CREATE OR REPLACE FUNCTION public.idmc_cw_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'This programme policy is permanently locked';
END;
$$;

CREATE OR REPLACE FUNCTION public.idmc_cw_legacy_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  grp text;
  mx numeric;
  mn numeric;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'Locked examination policy cannot be changed';
  END IF;

  IF TG_OP <> 'DELETE'
     AND NOT public.idmc_cw_role(
       coalesce(NEW.approved_by, NEW.created_by),
       ARRAY['ACADEMIC_OFFICER']
     ) THEN
    RAISE EXCEPTION 'Only Academic may set examination policy';
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.status <> 'LOCKED' THEN
    RAISE EXCEPTION 'Academic must lock examination policy';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT d.academic_group
      INTO grp
      FROM public.course_offerings o
      JOIN public.programmes p ON p.id = o.programme_id
      JOIN public.departments d ON d.id = p.department_id
     WHERE o.id = NEW.course_offering_id;

    IF grp = 'PROJECT' THEN
      mx := 50;
      mn := 25;
    ELSIF grp = 'SOCIAL' THEN
      mx := 60;
      mn := 30;
    ELSE
      RAISE EXCEPTION 'Assign programme department group first';
    END IF;

    IF NEW.coursework_weight <> mx
       OR NEW.examination_weight <> 100 - mx
       OR NEW.minimum_coursework_required IS DISTINCT FROM mn THEN
      RAISE EXCEPTION 'Examination policy must use the fixed programme maximum and minimum';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMIT;
