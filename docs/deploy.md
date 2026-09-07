# Release runbook

## This round (2026-09-07) — release checklist

Thirteen commits: the coach moves back to Sonnet 5, a per-person coach switch,
sign-in mail on AgentMail, E0 (endurance activities + sync) and E1 (subjective
capture), alert kinds + app badging, and prompt delivery on pg_cron.

### What CI does on merge to main

`deploy.yml` runs `supabase db push`, then deploys the functions, then publishes
the PWA — in that order, so the client can never ship ahead of its schema.

- **6 migrations**: `20260907010000` cost-by-model · `…020000` coach_access ·
  `…030000` activities · `…040000` subjective capture · `…050000` alert kinds ·
  `…060000` alert sweep cron.
- **4 functions**: mcp-server, coach, push-alerts, **endurance-sync** (new; the
  workflow did not know about it until this round).

### Your side, in this order

**1. Sign-in mail (AgentMail).** Nothing works without it — `config.toml` now
points at `smtp.agentmail.to` and the old Gmail credentials will not
authenticate. Create a **dedicated inbox** for this app; do not reuse a
listening address (see the comment in `config.toml` for why).

```bash
# .env.local, gitignored
SMTP_USER=<inbox>@agentmail.to     # this is also the From address
SMTP_PASS=<AgentMail API key, Dashboard → API Keys>
./scripts/push-auth-config.sh
```

Verify by requesting a sign-in code and reading where it came from.

**2. The prompt sweep.** Two halves that must match, or the sweep 401s:

```bash
supabase secrets set SWEEP_SECRET="$(openssl rand -base64 32)"
```
```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the same value as SWEEP_SECRET>', 'sweep_secret');
```

Set the secret **before** the deploy if you can; if not, nothing is lost —
`/sweep` returns 503 until it exists rather than running unauthenticated.

**3. Watch the cron migration land.** `20260907060000` installs `pg_cron` and
`pg_net`, which were available on this project and not installed. If
`supabase db push` refuses (some setups will not create these inside a
transaction), enable both from Dashboard → Database → Extensions and re-run the
push; the migration is guarded and idempotent, so a second run is safe.

Confirm:

```sql
select jobname, schedule, active from cron.job where jobname = 'alert-sweep';
```

### Optional, any time after

- **Connect an endurance source** — see setup.md. intervals.icu first: it is the
  only one that carries elevation LOSS, and `inserted_with_descent` on the first
  backfill is the number to read.
- **Add the second person** — account, MCP token (`--project-ref` makes the
  printed config paste-ready), and optionally a `coach_access` row.

### What needs a phone, and cannot be checked from CI

Push has never been verified end to end: no iPhone, no push service and no edge
runtime have been reachable in any session that built it. What IS pinned is the
crypto (RFC 8291 Appendix A, byte for byte, now actually run by CI), the RLS,
the client's network behaviour and the built worker's shape.

On the phone, in one session:

1. Turn rest alerts on; confirm the permission prompt appears.
2. Start a session, log a set, lock the phone. The alert should arrive, and the
   **app icon should show a badge** (new this round).
3. Open the app. The badge should clear.
4. Answer the morning check-in; confirm three items and no Save button, and that
   closing it keeps the answers.
5. Tap "Not today" on another day; confirm it does not ask again that day.

If the badge never appears but the notification does, that is iOS below 16.4 or
notification permission not actually granted — the badge is gated on both.


What to run after changing each layer. `docs/setup.md` is the one-time
bootstrap; this is the every-release path. Everything here is idempotent and
additive — nothing destroys data.

## Preflight (local, ~1 min)

```bash
node scripts/validate-db.mjs                      # migrations + views + RLS in PGlite
node scripts/check-selects.mjs                    # every SELECTed column exists
cd supabase/functions/mcp-server && deno check index.ts && cd -
cd supabase/functions/coach && deno check index.ts && deno test && cd -
cd pwa && npm run build && npm test -- --run && cd -
```

CI runs the same jobs on push; running them first just saves a round trip.

Note `npm run build`, not `tsc --noEmit`. `pwa/tsconfig.json` is a solution
file (`files: []` plus references), so `tsc --noEmit` resolves zero files,
prints nothing and exits 0 — a green that means only that it found nothing to
check. `npm run typecheck` (`tsc -b --force`) is the honest one.

## Database changed (new migration in supabase/migrations/)

```bash
supabase db push
```

Applies only migrations the remote hasn't seen. Never edit an applied
migration; add a new numbered file.

## Exercise seed changed (supabase/seed/*.sql)

Seeds do NOT run automatically in production — `db push` only applies
migrations. Apply them explicitly:

```bash
supabase db query < supabase/seed/exercises.generated.sql
supabase db query < supabase/seed/exercises.curated.sql
```

If `db query` is missing from your CLI version, paste the file into the
dashboard SQL editor. Both files are single idempotent statements and each
only updates rows it owns (`source = 'free-exercise-db'` / `'curated'`), so
re-running is always safe and never touches custom or edited exercises.

With no CLI and no way to paste 800 KB (the 2026-09-05 wrap-up ran from a
remote session with only the Supabase MCP), the generated seed's `images` and
`instructions` were applied SERVER-SIDE instead: enable the `http` extension,
have Postgres fetch `dist/exercises.json` itself, update from the JSON, and
drop the extension in the same transaction. Nothing about the schema survives
it. It refreshes only those two columns; the full seed still goes through the
commands above.

```sql
begin;
create extension if not exists http with schema extensions;
select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');
with src as (select (content::jsonb) as doc from extensions.http_get(
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json')),
rows as (select e->>'id' as id,
  coalesce(array(select jsonb_array_elements_text(e->'images')), '{}'::text[]) as images,
  coalesce(array(select jsonb_array_elements_text(e->'instructions')), '{}'::text[]) as instructions
  from src, jsonb_array_elements(src.doc) e)
update exercises x set images = r.images, instructions = r.instructions
  from rows r where x.id = r.id and x.source = 'free-exercise-db';
drop extension http;
commit;
```

## MCP server changed (supabase/functions/mcp-server/)

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

`--no-verify-jwt` is required every deploy: the function does its own bearer
auth and the gateway must not demand a Supabase JWT.

### Without the CLI: the Supabase MCP and a pinned bundle (retired 2026-09-06)

**Production no longer runs a shim.** On 2026-09-06 `mcp-server` was deployed
from source again (version 23, entrypoint
`supabase/functions/mcp-server/index.ts`), which is exactly the "next deploy
replaces it and nothing else has to change" the workaround was designed for.
The orphan branch `deploy/mcp-server-bundle` is now unreferenced and deletable.
Keep the rest of this section: the situation it solves recurs whenever a
session can reach the Supabase MCP but not the CLI.

The 2026-09-05 round went out from a remote session with no CLI and no deploy
settings, through the Supabase MCP's `deploy_edge_function`. That tool takes
file contents inline. `coach` (4 files) and `push-alerts` (3 files) went
through as source; `mcp-server` (28 files, 162 KB) did not fit, and a 100 KB
minified bundle is too long to retype by hand without error. So the deployed
`mcp-server` was a two-line shim: an `index.ts` that imported the bundle
by immutable commit sha from the orphan branch `deploy/mcp-server-bundle`
(`42a3c20`, bundle sha256 `29120c41…`), plus the real `deno.json`. The platform
bundler snapshots that file at deploy time; the running function never fetches
it. Deno resolves the bundle's bare specifiers (`zod`, the SDK, supabase-js)
through the import map like any local module.

To rebuild the bundle and check the sha before pointing a shim at it:

```bash
cd supabase/functions/mcp-server
deno bundle index.ts -o /tmp/index.js --platform deno --minify \
  --external=zod --external="@supabase/supabase-js" \
  --external="@sentry/deno" --external="@modelcontextprotocol/sdk/*"
sha256sum /tmp/index.js
```

Two things this path taught, both permanent:

- The next `supabase functions deploy mcp-server --no-verify-jwt` (by hand or
  from `deploy.yml`) replaces the shim with the source tree, and nothing else
  has to change. This is what happened on 2026-09-06, and nothing had to be
  undone. While a shim IS deployed, `get_edge_function` cannot byte-diff it
  against the repo, so verify by the bundle sha and the `/health` endpoint
  instead — `entrypoint_path` in `list_edge_functions` is the quickest way to
  tell the two states apart: a shim's is bare `index.ts`, a source deploy's is
  the full repo path.
- The tool carries source as a JSON string, and a backslash-u escape inside a
  regex literal arrived as the raw control character, which is an unterminated
  regex and a failed bundle. `push-alerts` now spells its label guard as code
  points for that reason. Avoid `\u` escapes in anything that has to go through
  this door; a regex with `\s` or `\d` is fine.

## Prompt delivery (the sweep)

Rest alerts and long-dated prompts share a table and use opposite mechanisms.

**Rest alerts** go through `POST /schedule`, which holds the edge worker open
until the alert fires. That works because a rest is two to five minutes, and the
function refuses anything longer rather than promising what the platform will
kill.

**Prompts** (morning panel, weekly OSTRC, next-morning pain) cannot use that:
07:30 tomorrow outlives any worker. They are split in two:

- `POST /arm` writes the row and returns 202. The PWA calls it via `armPrompt()`.
- `POST /sweep` sends whatever is due, driven by **pg_cron** (migration
  `20260907060000`).

### What the migration does, and what it cannot do

It installs `pg_cron` and `pg_net` (both available on this project, neither
previously installed), creates `run_alert_sweep()`, and schedules it every five
minutes as the job `alert-sweep`.

It deliberately does NOT contain the credentials. Those go in **Vault**, read at
run time, because a secret in a committed migration is a secret in a public
repository. Two rows, set once, in the SQL editor:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the same value as SWEEP_SECRET>', 'sweep_secret');
```

and the matching function secret:

```bash
supabase secrets set SWEEP_SECRET="$(openssl rand -base64 32)"
supabase functions deploy push-alerts
```

Until both Vault rows exist, `run_alert_sweep()` does nothing and raises a
notice each tick. That is on purpose: the alternative is firing an
unauthenticated request every five minutes forever and collecting 401s nobody
reads.

### Checking it

```sql
-- the job exists and when it last ran
select jobname, schedule, active from cron.job where jobname = 'alert-sweep';
select status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'alert-sweep')
 order by start_time desc limit 5;

-- what pg_net got back (async: the response lands here, not in the cron result)
select status_code, content from net._http_response order by created desc limit 5;

-- alerts that were armed but never sent
select kind, fire_at, sent_at, error from rest_alerts
 where sent_at is null and cancelled_at is null order by fire_at;
```

A healthy tick returns 200 with a JSON body counting `sent`, `stale` and
`failed`. A 401 means the Vault `sweep_secret` and the function's
`SWEEP_SECRET` do not match. A 503 means `SWEEP_SECRET` is unset on the
function.

### Two behaviours to know

- **Idempotent.** `sent_at` is stamped on send and the query only takes rows
  where it is null, so a double-firing or late scheduler costs nothing.
- **Six-hour grace window.** An alert whose moment passed longer ago than that
  is stamped stale and not sent, because asking about this morning at 3pm is
  worse than not asking. A sweep that stops for a day therefore drops that
  day's prompts rather than delivering a pile at once.

Five minutes rather than every minute: the prompts are daily and weekly, so the
latency is invisible and it is a twelfth of the wake-ups.

### If the cron is ever removed

Nothing breaks. Armed prompts sit unsent, and the PWA still asks in-app on
foreground, because `duePrompts()` in `pwa/src/lib/prompts.ts` is pure and knows
nothing about push. The only thing lost is being asked while the app is CLOSED.

## Endurance sync changed (supabase/functions/endurance-sync/)

```bash
supabase functions deploy endurance-sync
```

No `--no-verify-jwt`, same reason as the coach: the caller authenticates with
their Supabase session and the gateway should demand a JWT.

Nothing to set as a secret. The provider credentials are per USER and live in
`integration_credentials` (service role only), not in the function's
environment, because they are user data rather than deployment configuration.
A user with no row for a provider simply has that provider not connected.

Smoke test after deploying, with any user's session JWT:

```bash
curl -X POST "$FUNCTIONS_URL/endurance-sync/poll" -H "Authorization: Bearer <jwt>"
```

A user with nothing connected must come back **200** with
`"connected": []`, not an error. If that is a 4xx or 5xx, the "neither source"
path has regressed and the endurance layer has started being a dependency of
an app that must work without it.

On a first backfill, read `inserted_with_descent` in the response. Zero from a
full backfill means the descent rules later in the plan have nothing to gate on.
Expect zero if only Strava is connected: its activity list carries elevation
gain only.

## Coach changed (supabase/functions/coach/)

```bash
supabase functions deploy coach
```

No `--no-verify-jwt` here, and that asymmetry is the point: the coach
authenticates the caller with their Supabase session, so the gateway SHOULD
demand a JWT. Only `mcp-server` opts out, because it does its own bearer check
for a client that has no session.

Deploy it after `mcp-server` whenever a round changed both. The coach reaches
the MCP server over the network like any other client, so a coach that knows
about a tool the deployed server does not have gets a tool-not-found mid-turn.
The other order is merely a tool nobody calls yet.

A change to the SYSTEM PROMPT (`prompt.ts`) is a deploy too. It is bundled
into the function, not read from anywhere at runtime, so editing it and
pushing to main changes nothing a lifter talks to.

Secrets it reads, all optional except the first: `ANTHROPIC_API_KEY`,
`COACH_ALLOWED_USERS` (unset means everyone), `COACH_LOG_CONTENT` (`off` stops
storing conversation text), `COACH_MEMORY_EXTRACT` (`off` stops the post-turn
memory pass), `SENTRY_DSN`.

The post-turn memory pass reads `coach_usage.kind`, so `20260906050000` has to
be pushed FIRST. It is the one migration the coach's own quota check depends
on: without the column `overLimit` fails and every turn answers 503.

If the round changed `COACH_ALLOWED_USERS`, `COACH_LOG_CONTENT`,
`COACH_MEMORY_EXTRACT`, `SENTRY_DSN` or the API key, set the secret first and
then deploy — secrets are read at
boot, so a running function keeps the old value until it is replaced. Setting
the allowlist has no append: it is the whole list every time
([setup.md](setup.md#who-can-sign-up-and-who-gets-the-coach)).

## Rest alerts changed (supabase/functions/push-alerts/)

```bash
supabase functions deploy push-alerts
```

`verify_jwt` stays ON, exactly like the coach: the caller is the PWA with a
Supabase session. Push the migration (`20260905050000_push_alerts.sql`) FIRST;
the function reads three tables that did not exist before it.

There is no secret to set. The VAPID key pair is generated by the function on
first use and stored in `push_config` (RLS on, no policies, service role
only). Never delete or regenerate that row while subscriptions exist: every
phone's subscription is bound to the public half, and a new pair means every
device has to turn the row off and on again in Settings.

Two optional secrets. `PUSH_WALL_CLOCK_SECONDS` is the platform's wall-clock
limit for one edge worker — 150 on the Free plan, which is the default when
unset, 400 on paid plans. The function refuses (422) any alert it could not
hold until the deadline, so a paid project left at the default refuses every
rest over about two minutes for no reason: set it to 400 there. The limit is
per WORKER and workers are reused, so the usable window is shorter still on a
worker that has just slept through a rest; `rest_alert_refused` log lines carry
`left_s` and `worker_age_s` so you can see that happening. `PUSH_VAPID_SUBJECT`
is the contact URI RFC 8292 puts in every push token; it defaults to the app's
own Pages URL and only needs setting for a different deployment.

Smoke test: Settings → "Alert me when the app is closed" → ON, then log a set
with a 60 s rest and lock the phone. The function logs `rest_alert_scheduled`
and, a minute later, `rest_alert_sent` — or `rest_alert_skipped` if another
set was logged first, which is the cancel path working.

## PWA changed (pwa/)

Nothing to run. Push to main → the `deploy` GitHub Action publishes to
GitHub Pages. The installed app does NOT reload itself: `registerType` is
"prompt", so main.tsx applies a waiting worker only when no session is open
and otherwise defers to the next time the app is hidden — a mid-set reload
would take the staged reps and any half-typed note. Expect a lifter to get
the new build at their next visit, not within seconds of the push. Device
data survives updates (IndexedDB is untouched).

## Automating the Supabase half

`deploy.yml` can push migrations and deploy both edge functions itself, in
front of the Pages publish, so the client can never ship ahead of its schema.
It does so only when three repository settings exist; until then it prints a
notice and skips, and everything above stays by hand.

| Setting                 | Kind     | Where it comes from                                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | secret   | Supabase dashboard → Account → Access Tokens. Scope it to this one project if the dashboard offers it.                                       |
| `SUPABASE_DB_PASSWORD`  | secret   | The database password from project creation (Settings → Database). `db push` needs it; the access token alone does not reach Postgres.       |
| `SUPABASE_PROJECT_REF`  | variable | The project ref. Not secret, so a variable, but it stays out of the repo like every other ref.                                              |

Add them under Settings → Secrets and variables → Actions. The next push that
touches `supabase/` runs `supabase db push`, then `functions deploy mcp-server
--no-verify-jwt`, then `functions deploy coach`, and only after all three does
the Pages job start. A push touching only `pwa/` skips the Supabase job and
publishes straight away; a push touching only `supabase/` deploys the schema
and functions and does NOT republish the client, so nobody's phone offers an
update for a build that did not change.

What this trades away: a migration goes to production with no human between
the merge and the database. That is acceptable here for three specific
reasons, none of which is "it will probably be fine". CI has already run the
whole migration chain in PGlite before anything reaches main; migrations are
append-only by rule, so there is no destructive statement to fire; and
`db push` applies only what the remote has not seen, so a re-run changes
nothing. What is bought is that the failure mode this project has hit twice
(client first, schema later) stops being possible.

The exercise seeds stay by hand on purpose. They rewrite hundreds of rows in a
shared table, and "the seed changed" is a decision to re-seed, not a side
effect of merging.

## Adding or removing a person

```bash
node scripts/issue-mcp-token.mjs --user <uuid> --label "Who · which client"
```

Prints the token once plus the SQL to activate it. Full runbook, including
what is shared between users and what is not, in
[setup.md](setup.md#adding-another-user). Revoking is one statement:

```sql
update mcp_tokens set revoked_at = now() where label = '<that label>';
```

## Post-deploy smoke test (2 min)

1. `curl https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server/health`
   — `{"status":"ok",...}` with no credential.
2. Open the PWA, pull up Today — the week should load.
3. Ask Claude (MCP) to `search_exercises` for "pendulum" — curated rows
   should appear after a seed deploy.
4. After a migration touching views: load History for a lift with data.
5. After a migration touching auth or ownership: confirm each person still
   sees their own log and none of anyone else's.

## Known snags (learned the hard way)

- A commit is not a deploy, and the two halves go out separately UNLESS the
  three settings in "Automating the Supabase half" exist. Without them the PWA
  ships from a Pages build on push while a migration needs `supabase db push`
  and each edge function needs its own `supabase functions deploy` —
  `mcp-server` and `coach` are two deploys, not one. Shipping PWA code that
  reads or writes a column whose migration has not been pushed yet fails every
  such read or write until someone runs it — that has happened once already,
  with `prescriptions.set_type`. Push the migration FIRST, then the code that
  depends on it: the schema tolerates a column nothing writes, the app does
  not tolerate a column that is not there. With the settings in place the
  workflow enforces that order for you, which is the whole reason it exists.

- `alter database ... set` for custom GUCs is superuser-only on managed
  Postgres, so timezones live in tables instead:

  ```sql
  -- the deployment-wide default (everyone in one house)
  update app_config set value = 'America/Los_Angeles' where key = 'tz';

  -- one person who differs from it
  insert into user_config (user_id, tz) values ('<uuid>', 'Europe/Berlin')
    on conflict (user_id) do update set tz = excluded.tz;
  ```

  The MCP server resolves the same `app_tz(user_id)` for its own "today" and
  caches the answer per user per edge isolate, so after changing either,
  redeploy `mcp-server` rather than wondering why a training max still lands
  on the wrong day.

- Custom auth email templates need custom SMTP (free tier can't). SMTP creds
  come from `.env.local` via `scripts/push-auth-config.sh`.
- Auth redirect origins must be allowlisted (dashboard → Auth → URL
  Configuration) or magic links fall back to the Site URL silently.
