# Google Sign-In for Applicant Accounts (PostgreSQL Auth)

The Applicant Google flow uses IDMS's PostgreSQL Auth provider. Google verifies the account; IDMS verifies Google's signed ID token, creates an Applicant profile for a new verified email, and issues the existing PostgreSQL Auth session. Supabase Auth is not part of this flow.

## Google Cloud setup

1. In Google Cloud Console, select or create the institution's project and configure the OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**.
3. Add the deployed Applicant portal origin under **Authorized JavaScript origins** (for example, `https://admissions.example.ac.tz`). Add local development origins only in a development client.
4. Add the exact backend callback under **Authorized redirect URIs**:

   `https://<public-api-host>/api/v1/auth/google/applicant/callback`

   For local development with the sample backend settings, use:

   `http://127.0.0.1:4000/api/v1/auth/google/applicant/callback`

5. Request only the `openid`, `email`, and `profile` identity scopes. No Google password is requested or stored.

## IDMS backend configuration

For local backend development, set these environment values in the ignored `apps/backend/.env` file. The values have been added there. Never put the client secret in frontend config or commit it to source control.

```dotenv
AUTH_PROVIDER=postgres
GOOGLE_OAUTH_CLIENT_ID=<Google web client ID>
GOOGLE_OAUTH_CLIENT_SECRET=<Google web client secret>
GOOGLE_OAUTH_REDIRECT_URI=https://<public-api-host>/api/v1/auth/google/applicant/callback
FRONTEND_URL=https://<applicant-portal-origin>
```

`GOOGLE_OAUTH_REDIRECT_URI` must exactly match the URI registered in Google Cloud. Production callbacks must use HTTPS. The deployed database must have the existing PostgreSQL Auth migrations, Applicant role, and Applicant profile tables installed.

For the deployed Cloudflare Worker, all three Google OAuth bindings are stored as encrypted Worker secrets for `idms-imis-worker`. The application code change still needs to be deployed through the repository's release process before the live Applicant page can use the new flow.

## Account behavior

- A new Google identity with a verified email creates a local PostgreSQL Auth identity and Applicant profile.
- A returning identity is accepted only when its stored Google subject matches the verified Google subject.
- If the email already belongs to a password account or another identity, the flow stops and does not link accounts by email. The user must sign into the existing account and Admissions/ICT must follow the institution's approved linking procedure.
- Google sign-in cannot complete end-to-end until the institution configures the OAuth consent screen/test users and deploys the updated Worker code. No Google credentials are included in tracked source files.

## Verify before production

Test first on a staging deployment with the staging callback and Applicant portal origin. Verify a new Google Applicant, a returning linked Google Applicant, a mismatched existing email, a denied/cancelled attempt, and a disabled/inactive Applicant account. Then check the audit record and confirm the session is issued by PostgreSQL Auth. Do not use production credentials in local or staging environments.
