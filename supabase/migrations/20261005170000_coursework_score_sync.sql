BEGIN;

-- Keep the coursework component on the existing course result row in sync as
-- assessment marks and assessments pass through their normal approval flow.
CREATE OR REPLACE FUNCTION public.idmc_sync_coursework_component(
  p_course_offering_id uuid,
  p_student_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_policy_weight numeric(8,2);
  v_weighted_total numeric(12,4);
  v_available_weight numeric(12,4);
  v_coursework_mark numeric(8,2);
BEGIN
  SELECT crp.coursework_weight
    INTO v_policy_weight
  FROM public.course_result_policies crp
  WHERE crp.course_offering_id = p_course_offering_id
    AND crp.status IN ('ACTIVE', 'LOCKED')
  ORDER BY CASE WHEN crp.status = 'ACTIVE' THEN 1 ELSE 2 END, crp.created_at DESC
  LIMIT 1;

  IF v_policy_weight IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM((am.marks / NULLIF(a.maximum_marks, 0)) * 100 * (a.weight_percentage / 100)), 0),
    COALESCE(SUM(a.weight_percentage), 0)
  INTO v_weighted_total, v_available_weight
  FROM public.assessments a
  JOIN public.assessment_marks am ON am.assessment_id = a.id
  WHERE a.course_offering_id = p_course_offering_id
    AND am.student_id = p_student_id
    AND a.status IN ('APPROVED', 'LOCKED')
    AND am.status IN ('APPROVED', 'LOCKED');

  v_coursework_mark := CASE
    WHEN v_available_weight > 0
      THEN ROUND((v_weighted_total / v_available_weight) * v_policy_weight, 2)
    ELSE NULL
  END;

  UPDATE public.course_results cr
  SET coursework_mark = v_coursework_mark,
      result_status = CASE WHEN cr.result_status = 'CALCULATED' THEN 'DRAFT' ELSE cr.result_status END,
      calculated_at = CASE WHEN cr.result_status = 'CALCULATED' THEN NULL ELSE cr.calculated_at END,
      updated_at = now()
  WHERE cr.course_offering_id = p_course_offering_id
    AND cr.student_id = p_student_id
    AND cr.result_status IN ('DRAFT', 'CALCULATED');
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_sync_coursework_from_mark()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_offering_id uuid;
BEGIN
  SELECT a.course_offering_id INTO v_offering_id
  FROM public.assessments a
  WHERE a.id = NEW.assessment_id;

  IF v_offering_id IS NOT NULL THEN
    PERFORM public.idmc_sync_coursework_component(v_offering_id, NEW.student_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_sync_coursework_from_assessment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_student_id uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  FOR v_student_id IN
    SELECT DISTINCT am.student_id
    FROM public.assessment_marks am
    WHERE am.assessment_id = NEW.id
  LOOP
    PERFORM public.idmc_sync_coursework_component(NEW.course_offering_id, v_student_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_sync_coursework_from_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_student_id uuid;
BEGIN
  IF NEW.status NOT IN ('ACTIVE', 'LOCKED') THEN
    RETURN NEW;
  END IF;

  FOR v_student_id IN
    SELECT DISTINCT cr.student_id
    FROM public.course_results cr
    WHERE cr.course_offering_id = NEW.course_offering_id
      AND cr.result_status IN ('DRAFT', 'CALCULATED')
  LOOP
    PERFORM public.idmc_sync_coursework_component(NEW.course_offering_id, v_student_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_idmc_coursework_score_sync_mark ON public.assessment_marks;
CREATE TRIGGER trg_idmc_coursework_score_sync_mark
AFTER INSERT OR UPDATE ON public.assessment_marks
FOR EACH ROW EXECUTE FUNCTION public.idmc_sync_coursework_from_mark();

DROP TRIGGER IF EXISTS trg_idmc_coursework_score_sync_assessment ON public.assessments;
CREATE TRIGGER trg_idmc_coursework_score_sync_assessment
AFTER UPDATE OF status ON public.assessments
FOR EACH ROW EXECUTE FUNCTION public.idmc_sync_coursework_from_assessment();

DROP TRIGGER IF EXISTS trg_idmc_coursework_score_sync_policy ON public.course_result_policies;
CREATE TRIGGER trg_idmc_coursework_score_sync_policy
AFTER INSERT OR UPDATE OF coursework_weight, status ON public.course_result_policies
FOR EACH ROW EXECUTE FUNCTION public.idmc_sync_coursework_from_policy();

DO $backfill$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT cr.course_offering_id, cr.student_id
    FROM public.course_results cr
    JOIN public.assessments a ON a.course_offering_id = cr.course_offering_id
    JOIN public.assessment_marks am ON am.assessment_id = a.id AND am.student_id = cr.student_id
    WHERE cr.result_status IN ('DRAFT', 'CALCULATED')
  LOOP
    PERFORM public.idmc_sync_coursework_component(v_row.course_offering_id, v_row.student_id);
  END LOOP;
END;
$backfill$;

REVOKE ALL ON FUNCTION public.idmc_sync_coursework_component(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_sync_coursework_from_mark() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_sync_coursework_from_assessment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_sync_coursework_from_policy() FROM PUBLIC, anon, authenticated;

COMMIT;
