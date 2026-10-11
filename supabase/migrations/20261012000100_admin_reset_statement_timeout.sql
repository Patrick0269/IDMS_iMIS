BEGIN;

-- The reset RPC deletes rows across the reviewed dependency graph in one
-- transaction. Give this destructive, service-role-only operation up to the
-- documented Supabase Client API maximum while leaving other RPCs unchanged.
ALTER FUNCTION public.admin_data_reset_execute(text[], text, uuid)
  SET statement_timeout = '60s';

COMMIT;
