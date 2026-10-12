-- Run against idmc_imis_recovered_20261004 as a trusted local PostgreSQL admin.
-- This creates a restricted login for PostgREST, not an application admin.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$role$;

GRANT anon, authenticated, service_role TO authenticator;

-- Match Supabase's service-role behavior for trusted server-side API calls.
-- Only the backend holds this JWT; application authorization still runs in
-- the IDMS API before each request. Keep anon/authenticated under RLS.
ALTER ROLE service_role BYPASSRLS NOLOGIN;
ALTER ROLE anon NOBYPASSRLS NOLOGIN;
ALTER ROLE authenticated NOBYPASSRLS NOLOGIN;

-- After running this file, use psql's interactive `\password authenticator`
-- command to set its password without placing a plaintext secret in this file.
