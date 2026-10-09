BEGIN;

ALTER TABLE public.course_results
  DROP CONSTRAINT IF EXISTS course_results_result_status_check;
ALTER TABLE public.course_results
  ADD CONSTRAINT course_results_result_status_check
  CHECK (result_status IN (
    'DRAFT','CALCULATED','SUBMITTED','UNDER_REVIEW','VERIFIED',
    'HOD_VERIFIED','EXAMINATION_REVIEWED','DEPUTY_REVIEWED','PRINCIPAL_APPROVED',
    'APPROVED','PUBLISHED','LOCKED','WITHHELD','INCOMPLETE','CANCELLED'
  ));

ALTER TABLE public.course_results
  ADD COLUMN IF NOT EXISTS hod_verified_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hod_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS examination_reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS examination_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deputy_reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deputy_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS principal_approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS principal_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS workflow_comment text;

-- Normalize records from the previous HOD-only approval flow to the first
-- formal review stage so they cannot skip the new Examination/Deputy stages.
DROP TRIGGER IF EXISTS trg_validate_course_result_status_transition ON public.course_results;
UPDATE public.course_results
SET result_status = 'HOD_VERIFIED',
    hod_verified_by = COALESCE(hod_verified_by, reviewed_by, approved_by),
    hod_verified_at = COALESCE(hod_verified_at, reviewed_at, approved_at, updated_at)
WHERE result_status IN ('VERIFIED','UNDER_REVIEW','APPROVED');

CREATE OR REPLACE FUNCTION public.validate_course_result_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.result_status = OLD.result_status THEN RETURN NEW; END IF;
  IF OLD.result_status = 'DRAFT' AND NEW.result_status IN ('CALCULATED','CANCELLED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'CALCULATED' AND NEW.result_status IN ('SUBMITTED','DRAFT','CANCELLED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'SUBMITTED' AND NEW.result_status IN ('HOD_VERIFIED','CALCULATED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'HOD_VERIFIED' AND NEW.result_status IN ('EXAMINATION_REVIEWED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'EXAMINATION_REVIEWED' AND NEW.result_status IN ('DEPUTY_REVIEWED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'DEPUTY_REVIEWED' AND NEW.result_status IN ('PRINCIPAL_APPROVED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'PRINCIPAL_APPROVED' AND NEW.result_status = 'PUBLISHED' THEN RETURN NEW; END IF;
  IF OLD.result_status = 'PUBLISHED' AND NEW.result_status = 'LOCKED' THEN RETURN NEW; END IF;
  IF OLD.result_status = 'WITHHELD' AND NEW.result_status = 'HOD_VERIFIED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Invalid course result status transition: % -> %', OLD.result_status, NEW.result_status;
END;
$$;

CREATE TRIGGER trg_validate_course_result_status_transition
BEFORE UPDATE ON public.course_results
FOR EACH ROW EXECUTE FUNCTION public.validate_course_result_status_transition();

INSERT INTO public.permissions (permission_code,permission_name,module_code,action_code,description,status)
VALUES
 ('results.hod.verify','Verify Course Results','RESULTS','HOD_VERIFY','HOD verification before examinations review','ACTIVE'),
 ('results.examination.review','Review Course Results','RESULTS','EXAMINATION_REVIEW','Examination Officer review after HOD verification','ACTIVE'),
 ('results.deputy.review','Review Results as Deputy Principal','RESULTS','DEPUTY_REVIEW','Academic Deputy review before Principal approval','ACTIVE'),
 ('results.principal.approve','Approve Results for Publication','RESULTS','PRINCIPAL_APPROVE','Principal approval before Registrar publication','ACTIVE'),
 ('results.registrar.publish','Publish Approved Results','RESULTS','REGISTRAR_PUBLISH','Registrar publication after Principal approval','ACTIVE'),
 ('leadership.dashboard.view','View Leadership Dashboard','MANAGEMENT','DASHBOARD_VIEW','View role-scoped institutional dashboard metrics','ACTIVE')
ON CONFLICT (permission_code) DO UPDATE SET permission_name=EXCLUDED.permission_name,description=EXCLUDED.description,status='ACTIVE',updated_at=now();

INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE (r.role_code IN ('HOD','DEPUTY_HOD') AND p.permission_code='results.hod.verify')
   OR (r.role_code IN ('EXAM_OFFICER','EXAMINATION_OFFICER','EXAMINATIONS_OFFICER') AND p.permission_code='results.examination.review')
   OR (r.role_code='DEPUTY_PRINCIPAL' AND p.permission_code IN ('results.deputy.review','leadership.dashboard.view'))
   OR (r.role_code='PRINCIPAL' AND p.permission_code IN ('results.principal.approve','leadership.dashboard.view'))
   OR (r.role_code='DIRECTOR' AND p.permission_code='leadership.dashboard.view')
   OR (r.role_code='REGISTRAR' AND p.permission_code='results.registrar.publish')
   OR (r.role_code IN ('SUPER_ADMIN','ADMIN','SYSTEM_ADMIN') AND p.permission_code IN ('results.hod.verify','results.examination.review','results.deputy.review','results.principal.approve','results.registrar.publish','leadership.dashboard.view'))
ON CONFLICT DO NOTHING;

COMMIT;
