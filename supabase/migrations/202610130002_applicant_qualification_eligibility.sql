BEGIN;

-- Preserve the qualifications already entered, while representing Form Six and
-- Technician Certificate as real qualification types instead of overloading OTHER.
ALTER TABLE public.academic_qualifications
  DROP CONSTRAINT IF EXISTS academic_qualifications_type_check;

ALTER TABLE public.academic_qualifications
  ADD CONSTRAINT academic_qualifications_type_check CHECK (
    qualification_type IN (
      'PRIMARY','SECONDARY','ADVANCED_LEVEL','CERTIFICATE',
      'TECHNICIAN_CERTIFICATE','DIPLOMA','ADVANCED_DIPLOMA','BACHELOR',
      'POSTGRADUATE_DIPLOMA','MASTERS','PHD','PROFESSIONAL','OTHER'
    )
  );

ALTER TABLE public.academic_qualifications
  ADD COLUMN IF NOT EXISTS qualification_level smallint,
  ADD COLUMN IF NOT EXISTS certificate_number varchar(120);

ALTER TABLE public.academic_qualifications
  ADD CONSTRAINT academic_qualifications_level_check
  CHECK (qualification_level IS NULL OR qualification_level BETWEEN 1 AND 10);

UPDATE public.academic_qualifications
SET qualification_type='TECHNICIAN_CERTIFICATE', qualification_level=5
WHERE qualification_type='OTHER'
  AND lower(trim(coalesce(field_of_study,'')))='technician certificate';

UPDATE public.academic_qualifications
SET qualification_type='ADVANCED_LEVEL'
WHERE qualification_type='OTHER'
  AND lower(trim(coalesce(field_of_study,'')))='advanced level (form six)';

-- Rules are configured by Admissions/Academic staff from the institution's
-- approved entry policy. No programme is made eligible by default.
CREATE TABLE IF NOT EXISTS public.idmc_programme_admission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES public.programmes(id) ON DELETE CASCADE,
  intake_id uuid REFERENCES public.idmc_intakes(id) ON DELETE CASCADE,
  accepted_qualification_types text[] NOT NULL,
  minimum_qualification_level smallint,
  require_verified_qualification boolean NOT NULL DEFAULT false,
  approved_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(accepted_qualification_types) > 0),
  CHECK (accepted_qualification_types <@ ARRAY[
    'PRIMARY','SECONDARY','ADVANCED_LEVEL','CERTIFICATE',
    'TECHNICIAN_CERTIFICATE','DIPLOMA','ADVANCED_DIPLOMA','BACHELOR',
    'POSTGRADUATE_DIPLOMA','MASTERS','PHD','PROFESSIONAL','OTHER'
  ]::text[]),
  CHECK (minimum_qualification_level IS NULL OR minimum_qualification_level BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_idmc_admission_rule_programme_global
  ON public.idmc_programme_admission_rules(programme_id) WHERE intake_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_idmc_admission_rule_programme_intake
  ON public.idmc_programme_admission_rules(programme_id,intake_id) WHERE intake_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idmc_admission_rules_intake
  ON public.idmc_programme_admission_rules(intake_id,programme_id);

ALTER TABLE public.idmc_programme_admission_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idmc_programme_admission_rules FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.idmc_programme_admission_rules TO service_role;

COMMIT;
