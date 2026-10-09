BEGIN;
CREATE OR REPLACE FUNCTION public.prevent_financial_account_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Student financial accounts cannot be deleted';
END; $$;
COMMIT;
