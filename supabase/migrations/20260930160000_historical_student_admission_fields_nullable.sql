-- Historical student imports are verified by Admissions after loading.
-- They do not have an applicant, application or offer record to reference.
-- Keep the columns for regular admissions, but allow the controlled historical path.
BEGIN;

ALTER TABLE public.students
  ALTER COLUMN applicant_id DROP NOT NULL,
  ALTER COLUMN source_application_id DROP NOT NULL,
  ALTER COLUMN admission_offer_id DROP NOT NULL;

COMMENT ON COLUMN public.students.applicant_id IS
  'Nullable only for controlled historical student imports; normal admissions retain applicant linkage.';
COMMENT ON COLUMN public.students.source_application_id IS
  'Nullable only for controlled historical student imports; normal admissions retain application linkage.';
COMMENT ON COLUMN public.students.admission_offer_id IS
  'Nullable only for controlled historical student imports; historical imports are confirmed separately by Admissions.';

COMMIT;
