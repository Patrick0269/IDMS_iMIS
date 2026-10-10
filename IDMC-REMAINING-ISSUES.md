# IDMC iMIS Remaining Issues

## P0 — Verify runtime identity and authorization before production use

- **Applicant email and account-link source fix implemented locally:** profile create/update now require a confirmed Auth email and disallow redirecting admissions contact email; generic staff CRUD can neither supply nor infer the applicant's Auth identity. Offers use the confirmed Auth email. Student reconciliation rejects unverified or mismatched identities and refuses to replace an existing different student-user link. Middleware email healing can only claim an unlinked legacy profile and uses a conditional update; HTTP tests reject existing-owner takeover and concurrent claim races. Real Auth, live data, and SMTP tests are still required.
- **Student credential rollout (source fix implemented; deployment/E2E pending):** student login now rejects the issued student number as a password, login no longer creates/links accounts or auto-activates pending records, new staff-issued invitations no longer set a default password, and a rate-limited generic recovery endpoint sends secure setup links only to an existing linked Auth email. Verify the flow with real SMTP and student accounts before deploying. Accounts with synthetic `@students.idmc.local` Auth emails or no linked `students.user_id` require Registry/ICT reconciliation; the recovery endpoint deliberately does not send to those addresses. Test that pending students remain blocked and that recovery completion writes `password_changed_at`/security history.
- Run controlled Supabase checks for Auth linkage, password reset/change, user status, STUDENT role assignment, and role-specific portal routing.
- Verify protected routes with valid/invalid/expired tokens and least-privilege accounts. Confirm student data queries are scoped to the authenticated student's linked record.
- The backend uses a service-role Supabase client for data operations. Confirm every route has the correct permission checks and test effective RLS policies; service-role calls bypass ordinary RLS enforcement.

## P1 — Apply and verify cohort management in a disposable database

The first implementation is in the working tree: `supabase/migrations/20261007110000_cohort_management.sql`, `/api/v1/cohorts`, and `apps/frontend/cohorts.html`. Local evidence confirms the page is served and the unauthenticated API request is rejected. Source-level institution scoping now covers cohort operations and the five cohort migrations execute with core RPC invariants against a PGlite PostgreSQL fixture. A fresh read-only PostgREST schema probe against the configured Supabase target returned `42703` for cohort columns, confirming the migration is not visible there; no remote data or schema was changed. The fixture is minimal and does not prove behavior against the full Supabase schema, API, RLS, or configured remote database, so the feature remains PARTIAL.

- Apply the migration on a disposable Supabase project and compare its schema, function grants and permission assignments with the intended design.
- Exercise create/view/edit, duplicate code rejection, programme/year/intake filters, status changes, roster pagination, export and audit entries.
- Verify capacity at boundaries and with concurrent assignments; check capacity reduction is rejected when it would be below the current roster.
- Verify assignments/removals/transfers preserve programme/version integrity and only authorized roles can mutate roster data.
- CSV-cell quoting and formula-injection handling have unit coverage. Authenticated HTTP tests with mocked Supabase verify CSV headers/rows, IDMS tenant filtering, audit call and 10,000-cohort failure response. A user with `cohorts.view` only is denied assignment with no data/RPC/audit write; a `cohorts.manage` user completes the mocked HTTP→RPC→audit path. Still exercise against the full Supabase schema and real data on a disposable project.
- Review the migration and function behavior with a database administrator before deployment. Do not run this migration against production until the disposable test and backup/restore path are established.

## P1 — Historical-student end-to-end proof

On a disposable Supabase project, exercise upload → validate → preview → correct errors → save → second-person confirmation → import → admission confirmation/activation → identity/role linkage → student-number login → Student Portal. Verify own-record scoping, registrations, attendance, results, timetable, fees, audit trail, retry and rollback. Test duplicate identifiers, partial failures, concurrency and recovery.

- **Historical academic import confirmation (resume implemented locally; remote apply/E2E pending):** batches can now resume after interruption, each attempt and import-row link commit in one RPC transaction, and imported rows are idempotent. Only the current batch owner can mark a failed row skipped; takeover stops the former officer from importing or altering row state. GPA/CGPA recalculation and final batch transition happen after all pending rows are resolved; if recalculation fails, the batch stays `IMPORTING` and an authorized officer can resume. PGlite verifies takeover, four-eyes, duplicate-safe re-entry, owner-checked failures and prevention of finalizing pending rows. Apply the migration on a disposable Supabase database and verify HTTP resume, partial failure, concurrent requests, and real GPA recalculation.

## P1 — Verify migration deployment state

- Compare the remote migration ledger to all 122 files in `supabase/migrations/` and confirm actual schema, indexes, triggers, functions and RLS policies.
- Review migration compatibility and restore a backup into a disposable database before applying pending changes.
- Apply pending migrations only through the controlled deployment process; test restore/rollback.

## Finance data and refund workflow verification

Generic CRUD is read-only for charges, invoices, payments and refunds. Finance Portal and refund workflow routes handle controlled writes; staff refund transitions are audited and requester self-approval is blocked. Verify these paths against a disposable Supabase database.

## P2 — Finish operational verification

- Exercise invoice, payment, receipt upload, refund, finance reconciliation, reports and exports with representative test data.
- Test document/storage access boundaries and notification/email delivery with non-production accounts.
- Browser-test each role portal and important form, including validation failures, permission denial, empty states, pagination and downloads.
- Establish representative performance baselines for student search, dashboards, reports, registration and imports; review query plans and pagination limits.
- Run a security review focused on service-role use, object-level authorization, remaining mass assignment in other modules, upload validation, audit-log integrity, rate limits, CORS and exposed configuration. Workflow writes in `workflow.routes.ts` log sanitized alerts when an audit insert fails. Staff admission acceptance/decline and student registration approval now use atomic service-role RPCs with audit rollback; generic registration approval CRUD is disabled. Their migrations are local only; apply them on a disposable Supabase project first. Other multi-step workflow writes still need transaction/outbox review and database audit immutability checks. Generic CRUD writes for calculated results, semester results, academic standings, GPA records, assessment submissions/marks and mark corrections have been disabled in favor of dedicated workflows. Examination period/paper/session status and candidate eligibility fields are now excluded from generic CRUD; published schedules are read-only and publication is CAS-protected/audited. Examination mark entry validates candidate eligibility and mark limits, while submit/approve/lock transitions require the expected prior state and a different approving officer. Verify these paths against the live role matrix.
- Final registration is now handled by `register_student_registration_atomic`: the status change, student activation and audit share a database transaction. This migration is local and must be applied and verified on a disposable Supabase project before deployment. Portal account linking follows as a separate recoverable step. Other multi-step workflow writes still need transaction/outbox review and database audit immutability checks.
- Assessment correction decisions now use `decide_assessment_mark_correction_atomic`, including mark and percentage updates and audit. Graduation finalization now uses `finalize_graduation_atomic` for candidate/student state, award, certificate, alumni, lifecycle event, notification and audit. Both migrations are local and have fixture coverage; remaining workflow writes and live role/RLS behavior still need review.

## Production readiness answers

| Question | Status | Why |
|---|---|---|
| Backend starts? | PASS | Local process started; health route returned 200. |
| Frontend starts? | PASS | Local static server started; login and cohort page returned 200. |
| Database connects? | PASS | Read-only `/api/v1/ready` succeeded against the configured Supabase endpoint. |
| Authentication works? | PARTIAL | Auth code and unit checks exist; no real account sign-in was tested. |
| RBAC works? | PARTIAL | Middleware and mocked allow/deny tests exist; no live role session was tested. |
| Important portals route correctly? | PARTIAL | Pages/routes exist; role-specific redirects were not tested. |
| Student Portal works? | PARTIAL | Pages and APIs exist; no authenticated student session was tested. |
| Historical student can import and log in? | BLOCKED | Requires a disposable live database/Auth journey. |
| Cohort management works? | PARTIAL | Page/API and migration are implemented; configured database lacks the new columns (`42703`); no migration or data write was made. |
| Course relationships work? | PARTIAL | Schema/API tests exist; live linked records were not verified. |
| Important forms save real data? | BLOCKED | No controlled database form submissions were made. |
| APIs work? | PARTIAL | Local health/root and cohort authentication gate pass; live data routes are untested. |
| Exports/downloads work? | BLOCKED | No authenticated CSV or document download was run. |
| Migrations consistent? | PARTIAL | Static uniqueness scan passes; remote migration ledger is unknown. |
| Performance bottlenecks identified/fixed? | PARTIAL | Middleware/indexes exist; no realistic benchmark was run. |
| Critical security issues addressed? | PARTIAL | Baseline controls/tests exist; live RLS and penetration validation remain. |
| Important pages tested? | PARTIAL | Local pages and source tests cover selected modules; authenticated browser/database E2E remains. |

## Local verification status

Final registration, assessment correction and graduation finalization are included in the current checks. `npm run test:ci` passes typecheck, build and all 167 tests; `npm run audit:write` reports 122 migrations, 797 routes and 63 forms with zero failures. These migrations have not been applied to a database.

PGlite and route-contract checks pass for final registration, assessment correction and graduation finalization; those checks are included in the 167-test suite.

The assessment-correction, final-registration and graduation-finalization migrations remain local and have not been applied to any database.

The latest backend suite passes 167 checks, including institution-scoped Staff Operations authorization and field projections, Examination lifecycle protections, cohort assignment pagination, atomic transcript lifecycle, student registration approval/finalization, assessment correction and graduation finalization; the latest integration audit reports 122 migrations, 797 routes and 63 forms with zero failures. Transcript, staff admission acceptance, student registration approval/finalization and assessment-correction migrations are local only; configured Supabase deployment was not changed. Cohort's page now retains selected students while paging/searching the candidate list and enforces the 200-record assignment limit. Admissions verification, offer issuance, staff acceptance/decline and historical academic batch creation, row import, resume, failure recording and rollback use service-role-only database transactions; student rollback is also atomic. PGlite covers PostgreSQL email wildcard escaping, partial-write failure injection, takeover, idempotency, ownership, finalization and refund reservation guards. Refund totals include pending requests, are checked while holding a payment-row lock, and are enforced by database triggers that also prevent lowering payment value below active reservations or changing a payment's student after refunds are recorded; these refund/payment migrations are not applied to the configured Supabase database. Staff file routes enforce strict base64, recognized type signatures, MIME/extension match and aggregate request caps; private storage routes check PDF/JPEG/PNG/WebP signatures against declared MIME before saving. Student, Admissions and Finance downloads reject untrusted hosts, traversal and paths outside the relevant student/application/receipt folders, and re-sign valid same-project legacy object URLs. Generic CRUD responses are constrained to declared fields, and Admissions applicant CRUD cannot write or infer Auth identity links. These checks do not replace malware scanning, deep document parsing, or live bucket-policy testing. Existing legacy objects outside current `admissions/`, `applicants/` and `finance/receipts/<student>/` prefixes need controlled path migration. Applicant email ownership, unconfirmed-email healing prevention and converted-student reconciliation rules have mocked HTTP coverage; student portal reconciliation additionally refuses to replace an existing student link with a different IDMC account. Student Portal, Student Engagement, staff workspace, mounted institution-scoped Staff Operations and self-service action errors now go through sanitized shared handling; provider infrastructure failures return retryable server errors. Partial-load warnings no longer reveal raw database messages. Other new migrations also remain unapplied to the configured Supabase database. The active-library-reservation unique-index migration requires a pre-deployment duplicate check; if active duplicates exist, review and resolve them manually before applying it. The production dependency audit previously reported zero vulnerabilities after upgrading `proxy-addr` to patched 2.0.8. Audit IP attribution ignores spoofed `X-Forwarded-For`, and audit/service request IDs use middleware normalization. Passing local tests do not prove the production data path.
