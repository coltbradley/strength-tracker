# Release runbook

What to run after changing each layer. `docs/setup.md` is the one-time
bootstrap; this is the every-release path. Everything here is idempotent and
additive — nothing destroys data.

## Preflight (local, ~1 min)

```bash
node scripts/validate-db.mjs                      # migrations + views + RLS in PGlite
cd supabase/functions/mcp-server && deno check index.ts && cd -
cd pwa && npm run build && npm test -- --run && cd -
```

CI runs the same three jobs on push; running them first just saves a round trip.

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
GitHub Pages; the installed app picks it up on next launch (service worker
autoUpdate). Device data survives updates (IndexedDB is untouched).

## Post-deploy smoke test (2 min)

1. Open the PWA, pull up Today — the week should load.
2. Ask Claude (MCP) to `search_exercises` for "pendulum" — curated rows
   should appear after a seed deploy.
3. After a migration touching views: load History for a lift with data.

## Known snags (learned the hard way)

- `alter database ... set` for custom GUCs is superuser-only on managed
  Postgres. The timezone lives in the `app_config` table instead:
  `update app_config set value = 'America/Los_Angeles' where key = 'tz';`
- Custom auth email templates need custom SMTP (free tier can't). SMTP creds
  come from `.env.local` via `scripts/push-auth-config.sh`.
- Auth redirect origins must be allowlisted (dashboard → Auth → URL
  Configuration) or magic links fall back to the Site URL silently.
