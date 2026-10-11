BEGIN;

-- Allow the explicitly confirmed, service-role-only full reset enough time to
-- finish its single atomic transaction. This setting is scoped to this RPC.
ALTER FUNCTION public.admin_data_reset_execute(text[], text, uuid)
  SET statement_timeout = '10min';

COMMIT;
