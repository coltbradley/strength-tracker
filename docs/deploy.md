# Release runbook

## Where production stands (checked 2026-09-24)

Pushing to `main` deploys. `deploy.yml` runs `supabase db push`, deploys all
four functions, and only then publishes Pages. It does not wait on CI (A-134:
Actions billing). Check a release with `gh run list` and two log lines:

- `migrations + edge functions`: "Remote database is up to date" or the
  migrations it applied. A `supabase/` push without all three credentials
  fails at the gate step; it does not skip with success.
- `publish PWA` → `smoke`: a `receipt sha=… served_sha=…` line. The smoke
  polls the served `build.json` until it names the pushed commit and fails the
  job otherwise (A-135), so `served_sha` equal to `sha` means Pages is serving
  that exact build.

Live as of that check: migrations match local through `20260924200000`;
`mcp-server` v62, `coach` v24, `push-alerts` v9, `endurance-sync` v6 all
ACTIVE; `/mcp-server/health` answers ok. `COACH_ALLOWED_USERS` is set (the
coach is fail-closed without it). Run 36052798728's receipt showed
`served_sha` equal to `sha`.

Still open:

- **The prompt sweep is not configured**, and that is deferred to Phase 5
  (A-137/A-138). No `SWEEP_SECRET` function secret and no Vault rows exist,
  so every cron run succeeds while delivering nothing. Rest alerts are
  unaffected. Check-in prompts appear in-app on foreground.
- **Push on a real phone** has still never been verified end to end (see
  "What needs a phone").

## 2026-10-01 per-exercise prefs sync (`feat/exercise-prefs-sync`)

Not yet released; it ships inside Version D (see "Version D release" below).
One migration, `20261001000000_exercise_prefs.sql`; the PWA depends on the new
table. `mcp-server` also changed on the integrated branch (a copy of
`lib/setLoad.ts`, `lib/prescriptions.ts`, `tools/manage_exercises.ts`), so it
must be redeployed; `deploy.yml` deploys all four functions on any
`supabase/` change, so that needs no extra step. `deploy.yml` pushes the
database before Pages, so the order is safe. A PWA served before the migration
would see every pref upsert fail against a missing table, so never publish
the PWA without the push. The migration was edited in place before it shipped,
so it is one file, applied once.

Post-deploy check: sign in on two devices, set a base weight on one and see it
on the other; `select count(*) from exercise_prefs` is non-zero. Also confirm
`supabase db push` listed exactly this migration (and, on the integrated
branch, the goals-policy migration below).

## 2026-09-17 round — release checklist

Deployed: its migrations (through `20260917030000`) and functions were live by
2026-09-19. Kept as the record of that round. Twenty-two tasks: set type and skips chosen at log time
rather than defaulted from the slot (`session_skips`), equipment-aware load
entry with correct plate math, a focus-hero session screen with a
tap-to-jump progress rail, calmer sync, and coach trends and observations
that read live instead of being recomputed or forgotten (`coach_observations`,
`v_trend_digest`). Spec:
`docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md`;
deviations: `docs/decisions.md`'s "Live session adaptation" section.

### What CI will do on merge to main

`deploy.yml` runs `supabase db push`, then deploys the functions, then
publishes the PWA — in that order, so the client can never ship ahead of its
schema.

- **4 migrations**: `20260917000000` session_skips · `20260917010000`
  coach_observations (adds `v_trend_digest`) · `20260917020000` note_memory ·
  `20260917030000` fk_indexes.
- **2 functions**: mcp-server (six new tools — `get_bodyweight`,
  `get_trends`, `get_observations`, `record_observation`,
  `resolve_observation`, `get_session_diff`) and coach (prompt rewrite, the
  TRENDS/OBSERVATIONS lines in the per-turn context block, and the
  note-memory extension to `POST /coach/checkin-memory` — the per-turn
  `extractMemory` pass itself is untouched). `push-alerts` and
  `endurance-sync` are unchanged by this round and need no redeploy.
- **PWA**: ships the whole session-screen change — set type and "Already
  warm" on the focus hero, the tap-to-jump progress rail, the 200ms log lock
  (corrections exempt), plates-vs-stack load presentation with a
  per-exercise device-local override, the forward-looking rest strip with
  RPE chips for the set just logged, and History's Log weight row and "What
  the coach is watching" section.

### Deploy order

Same rule as every round, plus one more: deploy `mcp-server` before `coach`.
The coach's rewritten prompt names all six new tools, and a coach that knows
about a tool the deployed server does not have yet gets a tool-not-found
mid-turn — the reverse order is merely a tool nobody calls yet.

### Before merging

```bash
node scripts/validate-db.mjs
node scripts/check-selects.mjs
cd supabase/functions/mcp-server && deno check index.ts && deno test --allow-env --allow-net && cd -
cd supabase/functions/coach && deno check index.ts && deno test && cd -
cd pwa && npm run build && npm test -- --run && cd -
```

`push-alerts` and `endurance-sync` need no re-check: this round does not
touch either.

### After it ships — none of this has been run yet

1. `curl .../mcp-server/health` — should answer ok.
2. Ask Claude (MCP) `get_trends` for a user with no bodyweight log, no
   check-ins and no logged working sets: should come back `trends: null`
   with a note, never a row of zeros.
3. Start a session against a day with a warmup-bracketed exercise: the
   WARMUP | WORKING control and "Already warm" should appear on the focus
   hero.
4. Log a set: the rest strip should name the NEXT set, not the one just
   finished, and offer RPE chips for the one just logged; leaving it
   untapped should keep the set unrated.
5. Finish a session with a skipped exercise: a `session_skips` row should
   land, and History should show both the Log weight row and "What the
   coach is watching".

This section stays a checklist, not a record, until the release has actually
gone out. Once it has, fold what changed into "Where production stands"
above the way the 2026-09-07 round's items were folded in, rather than
carrying two descriptions of the same release.

## 2026-09-07 round — release checklist

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
cd supabase/functions/mcp-server && deno check index.ts && deno test --allow-env --allow-net && cd -
cd supabase/functions/coach && deno check index.ts && deno test && cd -
cd supabase/functions/push-alerts && deno check index.ts && deno test lib/ && cd -
cd supabase/functions/endurance-sync && deno check index.ts && deno test normalize.test.ts && cd -
cd pwa && npm run build && npm test -- --run && cd -
```

GitHub Actions CI does not currently run on this repo (billing); run these
locally before merge. `node scripts/validate-db.mjs` replays migrations in
PGlite — that gate is local, not a green CI job on push.

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

**Before `db push` of `20260921030000`:** if production already has rows in
`integration_credentials`, set Vault secret `integration_encryption_key` first
(a long random string). That migration backfills encrypted `access_token` /
`refresh_token` values and raises if the key is missing when any row exists.
An empty table is fine without the secret.

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

### Is the sweep alive?

There is no pager. If prompts stop arriving while the app is closed, run
the queries above. A missing Vault row (`project_url` or `sweep_secret`)
means `run_alert_sweep()` does nothing and raises a notice each tick —
that is success-with-no-work, not a 401 storm. Rest alerts are a different
path (`POST /schedule`) and are unaffected. In-app prompts on foreground
keep working even if the cron is gone.

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
`COACH_ALLOWED_USERS` (unset returns 503; production MUST set this secret to the
intended user UUIDs). Setting it has no append: it is the whole list every
time. Do not log the value. `COACH_LOG_CONTENT` (`off` stops
storing conversation text), `COACH_MEMORY_EXTRACT` (`off` stops the post-turn
memory pass), `SENTRY_DSN`.

The post-turn memory pass reads `coach_usage.kind`, so `20260906050000` has to
be pushed FIRST. Quota is reserved up front via `reserve_coach_turn` (a
placeholder row per client `turn_id`); the model runs only after that succeeds,
and `record()` updates the placeholder in a `finally`. Without that migration
and RPC, reservation fails and every turn answers 503.

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
It requires three repository settings. A push that touches `supabase/` without
all three fails the supabase job and Pages does not publish. A push touching
only `pwa/` still skips the Supabase job and publishes straight away. All three
have been set since 2026-09-12.

| Setting                 | Kind     | Where it comes from                                                                                                                    |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | secret   | Supabase dashboard → Account → Access Tokens. Scope it to this one project if the dashboard offers it.                                 |
| `SUPABASE_DB_PASSWORD`  | secret   | The database password from project creation (Settings → Database). `db push` needs it; the access token alone does not reach Postgres. |
| `SUPABASE_PROJECT_REF`  | variable | The project ref. Not secret, so a variable, but it stays out of the repo like every other ref.                                         |

Add them under Settings → Secrets and variables → Actions. The next push that
touches `supabase/` runs `supabase db push`, then deploys `mcp-server`
(`--no-verify-jwt`), `coach`, `push-alerts` and `endurance-sync`, and only
after all of them does the Pages job start. A push touching only `pwa/` skips the Supabase job and
publishes straight away; a push touching only `supabase/` deploys the schema
and functions and does NOT republish the client, so nobody's phone offers an
update for a build that did not change.

What this trades away: a migration goes to production with no human between
the merge and the database. That is acceptable here for three specific
reasons, none of which is "it will probably be fine". Operators should run
`node scripts/validate-db.mjs` locally before merge (PGlite replays the
migration chain); that is not GitHub Actions CI, which does not run here.
Migrations are
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

0. The deploy log's `receipt` line has `served_sha` equal to `sha`. The
   workflow already fails otherwise; this is where to read it.
1. `curl https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server/health`
   — HTTP **200** and `{"status":"ok",...}` only when the function's
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set and the token store
   (`mcp_tokens`) is reachable; otherwise **503** with `"status":"unavailable"`.
   No credential on the request.
2. Open the PWA, pull up Today — the week should load.
3. Ask Claude (MCP) to `search_exercises` for "pendulum" — curated rows
   should appear after a seed deploy.
4. After a migration touching views: load History for a lift with data.
5. After a migration touching auth or ownership: confirm each person still
   sees their own log and none of anyone else's.

## Version D branch-local evidence

See the [2026-10-01 local verification report](superpowers/plans/2026-10-01-version-d-local-verification.md) for the codex branch's own evidence (`codex/version-d-light-plan` at `125d203`, 1,178 tests). It is not evidence for the integrated branch and says so in its header. This implementation run has no served SHA or deployment receipt.

The integrated branch (`feat/version-d`) DOES change the database: two new migrations (below). It does not change the IndexedDB version (`openDB(dbName, 1)`, stores `outbox` and `kv`, unchanged); new outbox fields are additive. Keep device storage during rollback. Its correction relationship witness remains in the outbox outside visible counts and replay. Older code can replay the void idempotently then delete the witness; after KV clearing, that can lose the relation and make the replacement look like an ordinary Synced set. The local evidence report records this limit and storage cost.

## Version D release (`feat/version-d`)

Status: DEPLOYED 2026-10-01 at `5a6f97c` (`deploy.yml` run 36938114881:
migrations, edge functions and Pages all succeeded). The Phase 2 browser gate
(3) and the phone verification (4) below are still NOT RUN. Work added to
`feat/version-d` after `5a6f97c` (human-precision load display) ships in a
follow-up deploy.

The former OPEN decision is RESOLVED: the owner chose to deploy and repair the
phone's failed writes on the phone (step 6), not to waive them. The two
documents that disagreed ("release waives recovery" in
`docs/superpowers/plans/2026-09-30-version-d-execution.md` and the Version D
spec, versus "do not deploy without reviewing the queue" in
`docs/superpowers/plans/2026-09-30-load-sync-recovery.md`) are both superseded
by that choice.

### 1. Migrations, in order

`supabase db push` applies, after `20260924200000`:

1. `20261001000000_exercise_prefs.sql`: the `exercise_prefs` table, its
   last-write-wins trigger and owner RLS (insert and update also require the
   exercise to be visible to the caller). No function change depends on it.
2. `20261001010000_goals_visible_exercise.sql`: replaces `goals_insert` and
   `goals_update` with the same visible-exercise check. A new file; the
   original goals policies in `20260825120002` are untouched. Existing goal
   rows are untouched.

Applied migrations are never edited or rolled back. Confirm the push listed
exactly these two; `node scripts/validate-db.mjs` runs both against the real
chain locally (including the refused cross-user cases).

### 2. `deploy.yml` order

Unchanged and relied on: `supabase db push` (migrations), then the four
functions in this order (`mcp-server`, `coach`, `push-alerts`,
`endurance-sync`), then Pages. The PWA must never ship before the migrations.
Only `mcp-server` has code changes on this branch (the byte-identical
`lib/setLoad.ts`, `lib/prescriptions.ts`, `tools/manage_exercises.ts`,
`tools/repeat_planned_workout.ts`); it must be redeployed. The three deploy
settings (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`)
must exist or any `supabase/` push fails at the gate and Pages does not
publish. Receipt: `served_sha` equals `sha`; `/mcp-server/health` ok.

### 3. Phase 2 browser gate (NOT RUN)

Required by the Version D spec and the active roadmap before a release. It
needs Docker and a local Supabase stack, neither available in the sessions
that built this branch, so it has never run; the selectors were updated for
the new Session screen and are untested. From the repo root: `supabase start`,
`supabase db reset`; put the local URL and anon key in the ignored
`pwa/.env.e2e.local` and the local service role key in
`pwa/.env.e2e.admin.local`; then from `pwa/`: `npm ci`,
`npx playwright install chromium`, `npm run test:e2e:phase2`. The runner
prints `NOT RUN` and exits 3 if it cannot run, so a skipped gate cannot look
like a pass. Hosted URLs are refused. Record the result here.

### 3b. Live load-sync gate (pre-release, not CI)

Drives the demo in real Chromium in lb and kg, records every write the app
queues, and replays them into PGlite with the full migration chain. Needs
Chromium (`npx playwright install chromium` under `pwa/`), so it is not in CI.
From the repo root, after `npm --prefix pwa ci && npm --prefix scripts ci`:
`node pwa/e2e/live-load-sync.mjs --label release --out /tmp/live-e2e` (about
12 minutes). It must exit 0 with no `--allow` flags: 0 rejected writes, 0
invariant violations, 0 gating mismatches. `authored-drift` and `log-refused`
rows are informational. Last run on `fix/display-precision`: 182 writes
captured, 182/182 accepted, 0 gating mismatches. See
`docs/live-load-sync-e2e.md`.

### 4. Phone verification (NOT RUN)

On the real installed iPhone, new data only, recorded here with the served SHA:

- Offline logging: airplane mode, log sets (and a correction), confirm each
  says "On this phone", reconnect, confirm they move to Saved.
- Update and reconnect: the update prompt appears and applies; foreground and
  background the app mid-workout; the dock, rest clock and queue survive.
- Exact-UUID readback: after reconnect, read the new sets and any void back
  from the server by UUID and compare with the phone's queue count. A count
  alone does not establish identity. A set is Saved only on its exact UUID.
- Also confirm: a base weight set on one device appears on a second; dark theme
  without a flash while the manifest stays light; the Train finished-session
  line says "N sets confirmed on the server" only after readback.
- Rollback path recorded: revert the `gh-pages` commit; keep the exported queue
  and the original IndexedDB rows; never clear phone storage.

### 5. Local gate (done before this release, for the record)

Run from a clean checkout, all must pass: `npm run typecheck`, `npm test --
--run` (twice, to catch flakes) and `npm run build` in `pwa/`;
`node scripts/build-exercise-seed.mjs && node scripts/validate-db.mjs &&
node scripts/check-selects.mjs && node scripts/check-release-ledger.mjs`; the
`node --test` list in `ci.yml`; `npx deno check index.ts && npx deno test
--allow-env --allow-net` in each function that has tests.

### 6. The phone's 10 failed writes (recovery)

The affected iPhone's Unsynced Writes screen shows 10 failed writes, all
queued by one owner in one session: 7 set inserts refused by the authored-load
trigger (`load_kg must match entered_load, entered_unit, and load_entry`), plus
2 voids and 1 note refused by row-level security because their parent sets
never landed. The split-squat and calf-raise voids each target an earlier copy
in a correction pair, so a successful recovery leaves 5 of the 7 sets live.
A read-only server check (export SHA-256 `2dcec370efabc5530a82cc39890e65496c30b5ebbd960a587121bcc309d1d421`)
found none of the 7 set UUIDs, 2 voids or the note on the server. Post-replay
queue count and server readback by UUID are NOT RUN.

Batch-repair procedure (commit `2939f91`, typed-weight restoration on
`fix/queue-repair-typed`; Outbox sheet), on the phone, before or right after the
new build installs. The lifter confirmed they typed pounds, and the repair now
restores those typed weights instead of marking them unknown:

1. Open Unsynced Writes. Do not clear storage, sign out or reinstall.
2. Export the queue and save the file (the repair stays locked until a current
   export is saved and the review box is ticked; the file does not need to be
   sent to anyone).
3. Review the list. Each set now reads like "Barbell Squat · set 6: 145 lb (was
   saved as 65.8 kg) · 65.77 kg total". Check each weight is what you typed
   (expected: 145, 75 twice, 100, 115 three times lb), tick the saved-export
   box, and choose "Repair all N sets and retry". It validates every row and
   the owner against the export and changes all or none. The typed weight is
   solved from the kept total (a number on the 0.5 lb or 0.25 kg grid whose
   trigger formula gives exactly that total); `load_kg`, UUID, owner, time,
   index, reps, RPE and rest never change. If no typed weight reproduces a
   total, that set falls back to "weight unknown" with the total kept. Each
   rewritten payload also passes the admission gate; a row the database would
   refuse again leaves the whole batch untouched.
4. Wait for the sets to sync. Only then use Retry failed for the linked voids
   and the note (they stay parked while their parent set is in the queue;
   retrying them earlier gets the same refusal).
5. Expected outcome: 5 live sets (squat set 6; split squat set 3 at RPE 8; leg
   curl set 5; calf set 2 with its note; calf set 3 at RPE 9) and an empty
   queue. Then read all 7 set UUIDs, the 2 voids and the note back from the
   server by UUID and record the phone's queue count here.

Rehearsal (run it before touching the phone; needs `npm --prefix scripts ci`
and `node scripts/build-exercise-seed.mjs`). It boots the full migration chain
in PGlite, recreates the owner, exercises, prescriptions and the ended session,
runs the same repair function the app uses on the export, replays it as the
owner in outbox order (sets, then voids and notes behind their parents) and
asserts: all 10 accepted, exactly 5 live sets, each restored set `lb` with
145/75/100/115 and `load_kg` unchanged, voided originals hidden, and a second
full replay a no-op. The real export is never committed; give the script its
path and keep the report outside the repo:

```bash
node scripts/rehearse-queue-repair.mjs /path/to/phone-export.json | tee /tmp/rehearsal-report.txt
```

CI runs the same script on the anonymized fixture
`scripts/fixtures/phone-queue-anonymized.json` (`scripts/rehearse-queue-repair.test.mjs`).
Run against the real export on 2026-10-01: PASS, 7 of 7 assertions. That proves
the procedure on the schema, not the phone: the phone repair and the production
readback remain NOT RUN.

Status, 2026-10-01: the owner ran the repair on the phone after the `5a6f97c`
deploy and reports the sets repaired. NOT yet confirmed: the server readback by
set UUID (`v_live_sets` for that session; expect 5 live rows with
`entered_unit` 'lb' at 145, 75, 100 and 115) and the phone's post-repair queue
count. Treat the phone data as repaired-by-report until that readback is run.

## Rollback

- **PWA:** revert the `gh-pages` commit, or revert the `main` commit that
  triggered Pages and re-run `deploy`. Device IndexedDB is untouched either
  way.
- **Migrations:** do not roll back. Add a new numbered migration. Applied
  migrations are append-only; a database undo is not a release lever this
  project has.
- **Functions:** `supabase functions deploy <name>` from the previous
  known-good SHA (`mcp-server`, `coach`, `push-alerts`, `endurance-sync`).
  `mcp-server` stays `--no-verify-jwt`.

## Known snags (learned the hard way)

- A commit is not a deploy, and the two halves go out separately UNLESS the
  three settings in "Automating the Supabase half" exist. Without them, a
  `pwa/`-only push still publishes Pages, but any push that touches
  `supabase/` fails the workflow and Pages does not publish for that run —
  migrations and functions still need `supabase db push` and each
  `supabase functions deploy` by hand until the settings exist. Each function
  is its own deploy. Shipping PWA code that reads or writes a column whose
  migration has not been pushed yet fails every such read or write until
  someone runs it — that has happened once already, with
  `prescriptions.set_type`. Push the migration FIRST, then the code that
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
