# Release runbook

What to run after changing each layer. `docs/setup.md` is the one-time
bootstrap; this is the every-release path. Everything here is idempotent and
additive — nothing destroys data.

## Preflight (local, ~1 min)

```bash
node scripts/validate-db.mjs                      # migrations + views + RLS in PGlite
node scripts/check-selects.mjs                    # every SELECTed column exists
cd supabase/functions/mcp-server && deno check index.ts && cd -
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

## PWA changed (pwa/)

Nothing to run. Push to main → the `deploy` GitHub Action publishes to
GitHub Pages. The installed app does NOT reload itself: `registerType` is
"prompt", so main.tsx applies a waiting worker only when no session is open
and otherwise defers to the next time the app is hidden — a mid-set reload
would take the staged reps and any half-typed note. Expect a lifter to get
the new build at their next visit, not within seconds of the push. Device
data survives updates (IndexedDB is untouched).

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

- A commit is not a deploy, and the two halves go out separately. The PWA
  ships from a Pages build on push; a migration needs `supabase db push` and
  an edge function needs `supabase functions deploy`, both by hand. Shipping
  PWA code that writes a column whose migration has not been pushed yet fails
  every write until someone runs it — that has happened once already, with
  `prescriptions.set_type`. Push the migration FIRST, then the code that
  depends on it: the schema tolerates a column nothing writes, the app does
  not tolerate writing a column that is not there.

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
