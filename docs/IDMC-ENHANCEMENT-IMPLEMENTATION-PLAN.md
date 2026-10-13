# IDMC iMIS Enhancement Audit and Implementation Plan

Date: 2026-10-13
Status: PostgreSQL-backed internal implementation and regression work complete; approved-data and Google credential/live-environment dependencies remain.

## Scope and architectural map

| User requirement | Existing module / source inspected | Planned handling |
|---|---|---|
| Programme catalogue and approved admission rules | `programmes`, `programme_versions`, `curricula`, `curriculum_courses`, `idmc_programme_admission_rules`; Academic Core | Reuse existing records; expose configurable eligibility only from approved rules; do not invent programme/grade/subject criteria. |
| Qualification-based applicant filtering | Applicant Self Service routes, applicant wizard, programme requirements editor | Backend filtering and submit-time revalidation; keep application, document and review records intact. |
| Course assignment and academic-period controls | Academic Progression module, `idmc_academic_stages`, `idmc_progression_rules`, assignment queue and existing academic registration RPCs | Reuse the existing preview/decision/assignment workflow; validate idempotency, intake/curriculum binding, roles and history. |
| Semester/year progression | `supabase/migrations/20261009160000_intake_progression.sql`, result approval routes/workflows and Worker schedule | Confirm approval and completeness gates; connect scheduled evaluation only to approved automatic rules, with recoverable outcomes. |
| Applicant authentication | Auth routes/services, Applicant Access page, account recovery and email services | Add Google OIDC only if the backend/provider configuration supports secure token validation; preserve email verification and role separation. |
| Student Portal and dependent screens | Existing student self-service, academic progression context and portal pages | Update only views that display stale or incomplete programme/period/course data. |
| Database integrity | `supabase/migrations/` (authoritative per `supabase/MIGRATION_POLICY.md`) | Versioned additive migrations; no destructive production SQL; inspect actual target history before deployment. |

## Initial findings

1. The checkout is on `main` and already contains uncommitted changes in applicant eligibility, academic routes, authentication, frontend pages, Worker schedule configuration, and migration `202610130002_applicant_qualification_eligibility.sql`. These are pre-existing user changes and must be preserved and reviewed before integration.
2. The existing academic model already supports programme versions, curricula, course placement by year and semester, intake-bound progression rules, result blockers, authorized manual progression, progression decisions/events, and course assignment guarded by student position. The migration `20261009160000_intake_progression.sql` is the central dependency.
3. The new applicant eligibility model requires an explicit approved rule per programme (and optionally intake). An unconfigured programme is hidden/rejected. This matches the instruction to rely on approved rules already in the system.
4. The initial source search did not find approved Social Work or Project Planning / Business Administration entry thresholds for individual grades/subjects, nor curriculum course lists proving the requested pathways. These must be read from actual configured records before any programme data is changed. The existing `direct_entry_requirements` display text alone is not automatically parsed into reliable rule logic.
5. Applicant registration already had email/password and recovery. Added a backend Google authorization-code flow for PostgreSQL Auth with state/nonce checks, verified-email provisioning, and no automatic linking of existing password accounts. Google OAuth client credentials and exact production callback are still institution-provided setup dependencies.
6. The repository's migration policy names `supabase/migrations/` as the only deployment source and requires verified migration history, backup and staging dry run for production.

## Implementation stages

1. Finish read-only inventory of relevant routes, SQL migrations, auth/provider handling, data seeds, current database connection configuration (without exposing credentials), test coverage, and deployment controls.
2. Review and preserve the pre-existing working tree changes; correct unsafe or incomplete parts in place.
3. Implement backend eligibility filtering and submit-time validation against approved programme/intake rules and verified applicant qualification data; ensure qualification updates invalidate eligibility display naturally.
4. Verify existing progression, manual preview/confirmation, audit, recovery/idempotency and scheduler behavior. Add only missing controls or constraints using additive migrations.
5. Add or complete applicant Google OIDC and password recovery only when the configured provider, secrets, email delivery and account-linking behavior can be implemented safely within the current architecture.
6. Update existing applicant, academic staff and student screens where required; preserve navigation and role-specific access.
7. Run project-supported typecheck/build and targeted/full regression tests requested by the brief; report exact results. Do not run production migrations or claim live deployment without verifying target, backup, migration history and authorization.
8. Provide a final implementation and limitations report, including deployment/rollback instructions for any migration.

## Risks and safeguards

- Programme curriculum/admission source data may be absent, stale, or incomplete. No course names, minimum grades, required subjects, or progression thresholds will be inferred.
- The configured database target may be production. Database queries must be read-only for audit; migrations require target verification, backup, staging validation and deployment approval.
- Existing uncommitted edits may be unfinished. Preserve them and verify each touched pathway before expanding changes.
- Scheduled progression must only invoke existing approved automatic rules after results approval and completeness checks; never infer approval from mark entry.
- Authentication changes can create account takeover or duplicate accounts. Google identities must be token-verified and linked only under an explicit safe policy; reset responses must remain neutral and tokens single-use/expiring.

## Verification update (2026-10-13)

- Backend typecheck/build succeeded as part of `npm run test:ci`.
- Full serial suite initially passed 208/208 with process-scoped `AUTH_PROVIDER=supabase`; after adding qualification migration integration coverage, the latest full serial run passed 210/210 under the same test configuration. The default machine `.env` uses PostgreSQL Auth, which is incompatible with several existing Supabase-mocked route tests; running under the intended provider resolves those failures.
- Integration audit and `audit:write` succeeded: 140 migrations, 876 routes, 73 forms, no reported failures. Manifest/API inventories now include the pending eligibility migration.
- `git diff --check` found no whitespace errors.
- Remote DB inspection failed because the linked database was not accepting connections in hot-standby mode. No migration, backup, or deployment was performed.
- Remaining blockers for full requested scope: live data/rules and approved grade/subject criteria could not be verified; Google OAuth credentials and live provider/staging verification remain; current eligibility automation checks qualification type/level/verification only.

## Continuation update (2026-10-13)

The applicant eligibility routes now query global and intake-specific policy rows separately and validate request intake IDs before database filtering. A new PGlite integration test covers the eligibility migration's preservation, explicit legacy mappings, constraints and uniqueness. A final repository search also found no approved programme-level curriculum lists or grade/subject thresholds in the available migration, seed, and documentation files. Typecheck/build passed; 210/210 full serial tests passed under Supabase-auth test configuration; integration audit and whitespace checks passed. The linked database remains unavailable, so production verification and migration are still pending. Google OAuth/provider setup and structured approved grade/subject criteria remain unresolved.

## Continuation update (2026-10-13, PostgreSQL-backed Google Sign-In)

Google Applicant Sign-In has now been implemented against the existing PostgreSQL Auth flow. The backend verifies Google OAuth authorization-code responses with state and nonce checks, provisions an Applicant profile for a verified new identity, refuses automatic linking where an IDMS account already uses that email, and issues the existing PostgreSQL Auth session. The frontend has Google controls on applicant login and registration. Setup details are in `docs/GOOGLE-APPLICANT-POSTGRES-AUTH-SETUP.md`.

Typecheck/build passed; full serial suite passed 212/212; focused Applicant/OAuth callback tests passed 7/7; integration audit passed with 140 migrations, 878 routes and 73 forms; whitespace check passed. Institution credentials, public callback registration, and staging Google end-to-end verification remain pending. No OAuth database migration was needed.
