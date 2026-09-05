# Release runbook

What to run after changing each layer. `docs/setup.md` is the one-time
bootstrap; this is the every-release path. Everything here is idempotent and
additive — nothing destroys data.

## Preflight (local, ~1 min)

```bash
node scripts/validate-db.mjs                      # migrations + views + RLS in PGlite
node scripts/check-selects.mjs                    # every SELECTed column exists
cd supabase/functions/mcp-server && deno check index.ts && cd -
cd supabase/functions/coach && deno check index.ts && cd -
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

## MCP server changed (supabase/functions/mcp-server/)

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

`--no-verify-jwt` is required every deploy: the function does its own bearer
auth and the gateway must not demand a Supabase JWT.

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

If the round changed `COACH_ALLOWED_USERS`, `COACH_LOG_CONTENT`, `SENTRY_DSN`
or the API key, set the secret first and then deploy — secrets are read at
boot, so a running function keeps the old value until it is replaced. Setting
the allowlist has no append: it is the whole list every time
([setup.md](setup.md#who-can-sign-up-and-who-gets-the-coach)).

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
