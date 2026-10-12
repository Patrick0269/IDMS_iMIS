# Local PostgreSQL API for internet deployment

The backend's existing table and RPC calls use the PostgREST protocol through
`@supabase/supabase-js`. This setup points those calls to PostgREST connected to
the restored PostgreSQL database. PostgREST listens on loopback only; do not
expose port 3001 directly to the internet. Publish it through a named
Cloudflare Tunnel and set the Cloudflare Worker's `POSTGREST_URL` to the
tunnel's HTTPS origin only, for example `https://db.example.org`. Supabase JS
adds `/rest/v1` to every database request; the backend's PostgREST fetch adapter
removes that prefix because standalone PostgREST serves routes from the origin
root (for example, `/users`).

The PC hosting PostgreSQL, PostgREST and `cloudflared` must remain powered on
and connected for internet users to reach the system.

## Database role

The migration `20261012000500_postgrest_runtime_roles.sql` creates the
restricted PostgREST login and JWT roles. After migrations finish, set a strong
password for `authenticator` with psql's interactive `\password authenticator`
command. `database/postgrest/Configure-PostgREST.sql` remains available as an
idempotent repair script. Keep `authenticator` non-superuser; its memberships
let PostgREST switch to `anon`, `authenticated` and `service_role` from JWT
claims.

## Runtime configuration

Use the official PostgREST v16.4 Windows x86-64 release (SHA-256 checked
before extraction), place `postgrest.exe` under `tools/postgrest/`, and launch
it with `postgrest.conf`. Its executable is local and git-ignored. Set these process
environment values before launch:

- `PGRST_DB_URI`: PostgreSQL URI for `authenticator` to
  `idmc_imis_recovered_20261004` on the local PostgreSQL port.
- `PGRST_JWT_SECRET`: long random key shared only with the backend. Set backend
  `LOCAL_AUTH_JWT_SECRET` to this same value.
- `POSTGREST_URL`: use `http://127.0.0.1:3001` for backend on this PC; use the
  Tunnel HTTPS origin in the Cloudflare Worker. The backend removes the
  `/rest/v1` prefix that Supabase JS adds before it reaches standalone PostgREST.
- `POSTGREST_SERVICE_ROLE_KEY`: JWT signed with `PGRST_JWT_SECRET` whose
  payload includes `role: service_role`.
- `AUTH_PROVIDER=postgres`: select PostgreSQL-backed login and sessions.
- `PUBLIC_API_URL`: public Worker URL ending in `/api/v1`, used for temporary
  private-file links.

The Worker must not receive the PostgreSQL password. Only local PostgREST
receives it. Keep the JWT secrets private and rotate them if they are exposed.

## Apply missing migrations locally

After restoring the snapshot, run
`scripts/Apply-IDMC-LocalPostgresMigrations.ps1` in PowerShell. It checks the
existing local migration audit and applies only missing timestamped migrations
above the snapshot baseline from both `supabase/migrations` and
`database/migrations`. If a version appears in both folders, the script checks
that the SQL contents match and applies it once. It does not create, drop, or
clear databases.

The new migration adds local Auth sessions and one-time email action tokens,
as well as a private file store in PostgreSQL. The backup snapshot did not
include the old file contents, so those files cannot be reconstructed from
metadata; owners must upload them again. New file uploads and private downloads
use PostgreSQL. `LEGACY_STORAGE_ORIGIN` is optional and only lets the backend
extract object paths from old Supabase Storage URLs recorded in metadata; it
does not connect to Supabase or recover missing file contents.

## Internet cutover checklist

1. Apply all outstanding SQL migrations to the restored local database.
2. Set the `authenticator` password as shown above.
3. Install PostgREST and verify its local connection.
4. Create a named Cloudflare Tunnel route to `http://127.0.0.1:3001` and use
   its HTTPS hostname for the Worker's `POSTGREST_URL`.
5. Set Worker variables/secrets: `AUTH_PROVIDER=postgres`, `POSTGREST_URL`,
   `POSTGREST_SERVICE_ROLE_KEY`, `LOCAL_AUTH_JWT_SECRET`, `PUBLIC_API_URL`,
   `FRONTEND_URL`, `JWT_SECRET`, and existing mail/CORS settings.
6. Deploy and verify `/api/v1/ready`, login, refresh, file upload, signed
   download, and a normal database workflow before removing old Supabase
   credentials.

Do not route production users to PostgreSQL until migrations and the public
Tunnel are verified. A Tunnel hosted from a PC still depends on that PC and its
internet connection.
