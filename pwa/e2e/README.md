# Phase 2 local browser gate

This opt-in Playwright test uses local Supabase and its seeded exercise
library. It creates two throwaway Auth users with local Supabase's admin API,
gets each user's real JWT through local password sign-in, and drives the PWA
in Chromium. App reads and writes use each browser user's JWT and RLS. The
runner refuses any Supabase or app URL whose host is not loopback, before it
reads the separate local admin-key file or contacts that service. The key is
never passed to the Vite server or printed by the harness.

The test covers plan creation and confirmation, session start and resume, one
offline set held in IndexedDB and then synced, a correction (void plus a new
row at the same index), additional sets, session finish, exact row readback,
and a second user's denied read and void attempt.

The email-code sign-in screen is NOT RUN by this suite. The repository's local
Auth SMTP points at the external AgentMail host, so this fixture uses local
password sign-in and sends no email.

## Run it

Start the local Supabase stack and apply migrations plus seeds:

```sh
supabase start
supabase db reset
```

Copy the local API URL and anon key from `supabase status` into the ignored
`pwa/.env.e2e.local` file:

```dotenv
PHASE2_SUPABASE_URL=http://127.0.0.1:54321
PHASE2_ANON_KEY=<local anon key>
PHASE2_APP_URL=http://127.0.0.1:5198
```

Put the local `service_role` key from the same `supabase status` output in a
separate ignored `pwa/.env.e2e.admin.local` file:

```dotenv
PHASE2_SERVICE_ROLE_KEY=<local service role key>
```

The configuration loader validates the Supabase and app URLs as loopback
before it opens this second file. Hosted Supabase URLs fail closed.

From `pwa/`, install the locked dependencies and the Playwright Chromium browser once:

```sh
npm ci
npx playwright install chromium
```

Then run:

```sh
npm run test:e2e:phase2
```

Use `PHASE2_BROWSER_CHANNEL=chrome` in the env file to run an installed Google
Chrome instead of Playwright's Chromium. If the required env values or local
services are missing, the runner prints `NOT RUN` and exits with status 3, so
an invoked gate cannot look like a pass. A non-loopback URL is a hard refusal
with exit status 2. Playwright traces are disabled, and generated report
directories are ignored so auth state is not saved in test artifacts.

## Data cleanup

The test creates random `@example.com` auth users and writes plans, sessions,
sets, and one void to the local database. Its `afterAll` cleanup deletes only
those two users; local foreign keys cascade their test rows. If the process is
forcibly stopped, use a dedicated local Supabase project or run `supabase db
reset` when replacing the whole local database is intended.

This browser suite does not prove a phone service-worker update run or replace
the roadmap's separate phone acceptance gate.
