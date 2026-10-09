BEGIN;

ALTER TABLE public.applicants
  ADD COLUMN IF NOT EXISTS birth_district varchar(100),
  ADD COLUMN IF NOT EXISTS birth_region varchar(100),
  ADD COLUMN IF NOT EXISTS birth_country varchar(100),
  ADD COLUMN IF NOT EXISTS marital_status varchar(30),
  ADD COLUMN IF NOT EXISTS permanent_address text,
  ADD COLUMN IF NOT EXISTS bank_name varchar(150),
  ADD COLUMN IF NOT EXISTS bank_branch varchar(150),
  ADD COLUMN IF NOT EXISTS bank_account_number varchar(100),
  ADD COLUMN IF NOT EXISTS nhif_card_number varchar(100);

ALTER TABLE public.applicants
  DROP CONSTRAINT IF EXISTS applicants_marital_status_check;
ALTER TABLE public.applicants
  ADD CONSTRAINT applicants_marital_status_check CHECK (
    marital_status IS NULL OR marital_status IN ('SINGLE','MARRIED','DIVORCED','WIDOWED','SEPARATED','OTHER','PREFER_NOT_TO_SAY')
  );

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS sponsorship_type varchar(50),
  ADD COLUMN IF NOT EXISTS sponsor_name varchar(200),
  ADD COLUMN IF NOT EXISTS sponsor_occupation varchar(150),
  ADD COLUMN IF NOT EXISTS sponsor_phone varchar(50),
  ADD COLUMN IF NOT EXISTS sponsor_address varchar(500);

ALTER TABLE public.application_next_of_kin
  ADD COLUMN IF NOT EXISTS occupation varchar(150);

COMMIT;
