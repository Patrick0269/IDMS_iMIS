-- Enable the scholarship office to lock reviewed applications without changing award records.
BEGIN;
ALTER TABLE public.scholarship_applications DROP CONSTRAINT IF EXISTS scholarship_applications_status_check;
ALTER TABLE public.scholarship_applications ADD CONSTRAINT scholarship_applications_status_check
  CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','LOCKED','CANCELLED'));
COMMIT;
