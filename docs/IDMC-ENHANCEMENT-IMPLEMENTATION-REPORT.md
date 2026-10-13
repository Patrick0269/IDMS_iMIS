# IDMC iMIS Enhancement Implementation Report

Date: 2026-10-13

## Summary

Reviewed the existing IDMC iMIS application and its current uncommitted changes. Preserved all pre-existing edits. Added the audit and implementation plan at `docs/IDMC-ENHANCEMENT-IMPLEMENTATION-PLAN.md`. Regenerated the repository's version-controlled integration inventories and migration manifest after confirming the new applicant eligibility migration is included.

This report describes the current working tree; the feature edits listed below were already present when this review began and are not represented as newly authored here.

## Current working-tree changes reviewed

- Applicant qualification form now captures qualification type/level and certificate number; its eligibility list is filtered by configured programme/intake rules, and application choices are revalidated by the backend.
- A configurable admission-rule table and migration were added in `supabase/migrations/202610130002_applicant_qualification_eligibility.sql`; rules are stored per programme and optionally per intake, with an approving user and policy reference. Programmes without a rule remain unavailable to applicants.
- An Academic staff editor exposes accepted qualification types, minimum level and verification requirements.
- Academic Management now has a direct sidebar entry to open the existing approved admission requirements editor. It records policy text/reference and automates only qualification type/level/verification checks.
- Applicant registration hides the completed initial form and provides password recovery using the existing neutral-response/rate-limited password reset flow.
- Academic progression already exists in the application and migration history: approved result checks, intake/programme/curriculum binding, configurable rules, previews, manual controls, idempotent decisions, events and course assignment. The working tree adds a five-minute Worker schedule to call that existing calendar tick.
- Existing student and staff portals, navigation, authentication separation, and academic history paths were retained.

No programme catalogue records or curricula were added or modified during this review.

## Data and policy findings

- The existing schema contains programme versions, curricula, course-by-semester placement, grade scales, academic qualifications, and configurable progression rules.
- Applicant qualifications currently hold a general grade plus a verification comment/metadata summary; the reviewed schema does not provide a normalized applicant subject-by-subject result record or a structured programme subject/grade policy.
- Repository documentation identifies curriculum structure fields, but does not establish the approved Social Work or Project Planning and Business Administration course lists or their entry thresholds.
- The linked database migration-list query failed because the database reported it was not accepting connections in hot-standby mode. Therefore the actual configured programme/rule records, live migration state, database target, and production backup could not be verified.
- Google OAuth was absent from the original applicant authentication flow. A backend Google OAuth authorization-code callback has since been added for PostgreSQL Auth. Google Cloud client credentials and production redirect configuration have not yet been supplied, so live provider sign-in remains unverified.

## Verification performed

- `npm run test:ci` under the machine's default `.env` setting (`AUTH_PROVIDER=postgres`): typecheck/build passed; tests reported 192 pass and 16 failures because these Supabase-auth integration tests were executed under the local PostgreSQL auth provider.
- Re-ran all 208 tests serially with `AUTH_PROVIDER=supabase`: 208 passed, 0 failed. The environment override was limited to that test process and did not alter `.env`.
- Ran targeted checks for the 20 initially failing auth/route tests with `AUTH_PROVIDER=supabase`: 20 passed, 0 failed.
- `npm --prefix apps/backend run audit:integration`: 140 migrations, 876 routes, 73 forms, no integration audit failures.
- `npm --prefix apps/backend run audit:write`: completed successfully and regenerated the migration manifest and API inventories, including migration `202610130002`.
- `git diff --check`: no whitespace errors.

No live application end-to-end test, remote migration, production backup, or deployment was performed.

## Limitations and deployment instructions

1. Restore database availability and verify the linked project/target and applied migration history before any deployment. Take and verify a database backup and run the migration against staging first, as required by `supabase/MIGRATION_POLICY.md`.
2. Review programme and intake admission rules against the institution's existing approved records. Configure each programme only from those records. The current rules cover qualification type, minimum level and verified status; they do not enforce grades or required subjects.
3. Before relying on automated eligibility for marks/subjects, add a structured approved policy and matching subject-result capture/verification workflow. Do not infer values from free-text `direct_entry_requirements`.
4. Configure Google OAuth using `docs/GOOGLE-APPLICANT-POSTGRES-AUTH-SETUP.md`; store the client secret on the backend only, then test new, returning, cancelled and existing-email cases on staging before release. The current policy refuses implicit linking when an IDMS account with that email already exists.
5. Deploy using the repository's existing release process only after backup, staging validation, schema-cache refresh if required, and review of the generated migration manifest.
6. Because migration `202610130002` has not been applied in this review, no production rollback was needed. Before applying it, prepare a reviewed forward-recovery migration and backup restore procedure; do not manually edit migration history or delete applicant qualification data to roll back.

## Continuation update (2026-10-13)

- Rechecked the linked database; it remains unavailable in hot-standby mode. No live data inspection or migration was possible.
- Applicant eligibility now loads programme-wide and intake-specific rules with separate parameterized filters; a user-supplied intake value is checked as a UUID before querying. The submission-time eligibility check uses the same helper.
- Added `apps/backend/test/applicant-qualification-eligibility.integration.test.mjs`. It applies the pending migration in PGlite, verifies existing qualification rows survive, verifies only the two explicit legacy labels are mapped, checks level/type constraints, and checks programme/intake uniqueness.
- Verification after these changes: `typecheck` passed; build passed; full serial suite passed 210/210 with process-scoped `AUTH_PROVIDER=supabase`; integration audit passed with 140 migrations, 876 routes and 73 forms; `git diff --check` passed.
- At that point in the work, Google OAuth configuration was still outstanding. The continuation below records the backend implementation now added for PostgreSQL Auth. Grade and subject rules remain outside the normalized, approved machine-readable policy model.

## Continuation update (2026-10-13, Academic Management access)

- Added a direct **Admission Requirements** entry in the existing Academic Management setup navigation. Selecting it opens and scrolls to the existing programme rules editor.
- Clarified editor guidance and save confirmation: staff should use approved source references, and grade/subject requirements are not treated as automated rules until structured approved criteria are available.
- Preserved the existing Academic Management page, sidebar, programme editor and permission-checked backend routes. No new application or duplicate module was created.
- Earlier verification remains 210/210 tests, integration audit passed and `git diff --check` passed. This navigation and copy adjustment was made after that suite; a new full suite was not run for this UI-only change.

## Continuation update (2026-10-13, Google Sign-In with PostgreSQL Auth)

- Added a server-side Google authorization-code flow for the Applicant login and registration page. It uses a short-lived HttpOnly/SameSite state and nonce cookie, verifies Google's ID token on the backend, and issues the existing local PostgreSQL Auth session. No Supabase Auth login flow is used.
- Added Google identity handling that creates a local Applicant auth identity and role/profile only for a verified Google email. Existing email accounts are not linked automatically; the Google subject must match the locally recorded identity on later sign-ins. A separate institution-approved linking procedure is still needed for existing accounts.
- Added backend-only settings `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI`; added rate limits and applicant UI controls; added [Google/PostgreSQL setup instructions](GOOGLE-APPLICANT-POSTGRES-AUTH-SETUP.md).
- Added the supplied values to the ignored local backend `.env` and to the encrypted Cloudflare Worker secret store for `idms-imis-worker`. Verified the Worker binding names without reading or displaying their values. No credential is in tracked source.
- Verification after this implementation: typecheck/build passed; full serial suite passed 212/212; the focused Applicant/OAuth callback tests passed 7/7 after adding backend state/nonce checks; integration audit passed with 140 migrations, 878 routes and 73 forms; `git diff --check` passed.
- Still required: ensure the OAuth consent screen includes the intended test users or is published as appropriate, then deploy the updated Worker code and run end-to-end tests. Secret bindings are configured, but this feature code has not been deployed and a live Google sign-in was not exercised. This addition requires no new database migration.
