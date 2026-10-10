# IDMC iMIS: login and role update

This folder is an updated source copy prepared from the supplied `IDMC_iMIS (17).zip` archive. The original archive was not changed.

## Changes

- Replaced the student/staff login mode toggle with one identifier-and-password form. Student-number formats are detected automatically; the backend still authenticates the account.
- Redirects use verified, active account roles. Admin starts on the existing dashboard; accounts with no active role see an access-denied page.
- Added a validated active-role header to API requests. Backend permission and role guards scope authorization to the selected, active, unexpired assignment.
- Added per-role permissions to the `/auth/me` response so frontend menus follow the selected role.
- Added role switching to the Admin Dashboard and shared role portals. Shared staff portal headers show the staff name, employee number when available, role, department when available, profile photo/avatar, profile link, and logout.
- Prevented a student number from being used as the password for student login.

No database migration was needed. Existing assignments, permissions and profile records are used. The ZIP does not include production `.env` files, dependencies, build output, backups, or test logs.

## Verification

- Backend typecheck: passed.
- Full backend test suite: **170 passed, 0 failed**.
- Focused login/role/portal regression tests: **29 passed, 0 failed**.
- JavaScript syntax checks for auth, API, RBAC, role portals, and dashboard: passed.

The backend suite was run with disposable test-only environment values and local test servers. Configure `apps/backend/.env` from `apps/backend/.env.example` before starting the application.
