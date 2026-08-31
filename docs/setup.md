# Setup runbook

One-time steps to go from this repo to a working system. Everything here
needs your Supabase account or your machine; nothing is destructive.

## 0. Install tooling (Mac)

```bash
brew install supabase/tap/supabase deno
```

Docker Desktop is only needed if you want the local Supabase stack
(`supabase start`); the remote-only path below doesn't need it.

## 1. Supabase project

1. Create a project at supabase.com (free tier is fine). Region: us-west.
2. In the dashboard, note the project ref, anon key, service role key.
3. Link and push the schema:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
```

4. Seed exercises (950+ rows across both files, idempotent, re-run any time):

```bash
node scripts/build-exercise-seed.mjs
supabase db query < supabase/seed/exercises.generated.sql
supabase db query < supabase/seed/exercises.curated.sql
```

If `supabase db query` isn't in your CLI version, paste the files into the
dashboard SQL editor. Each is a single idempotent statement.

5. Set your home timezone for calendar bucketing (dates and ISO weeks;
   without this, evening workouts land on the next UTC day). Dashboard SQL
   editor:

```sql
update app_config set value = 'America/Los_Angeles' where key = 'tz';
```

(`alter database ... set` is superuser-only on managed Postgres — that path
doesn't work; the config table is the supported one.)

This one row is the only definition of "today" the server side has: the
derived-metric views read it through `app_tz()`, and the MCP server reads the
same row when it stamps `training_maxes.effective_date` (see
docs/decisions.md). Set it before recording any training max, or an evening TM
lands on tomorrow and stays invisible. The MCP server caches the value for the
life of an edge isolate, so after changing it, redeploy the function (or just
wait: idle isolates recycle within minutes).

## 2. Your user

1. Authentication → Users → Add user (your email, or invite + magic link).
2. Copy the user's UUID. This is `OWNER_USER_ID`.
3. Authentication → URL Configuration: set the Site URL to your deployed PWA
   origin and add it (plus `http://localhost:5173` for dev) to the redirect
   allowlist. Magic links silently fall back to the Site URL for origins not
   on this list.
4. Authentication → Email Templates → Magic Link: make sure the template
   includes the `{{ .Token }}` 6-digit code as well as the link. The
   installed iOS app signs in with the code (the link opens in Safari, whose
   storage the installed app can't see).

## 3. MCP server

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

Endpoint: `https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server`

Health check, no credential needed:

```bash
curl https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server/health
```

Then mint yourself a token. A token IS an identity: the server hashes it and
looks up which user it belongs to, so this is the same command you will run for
anyone else you add.

```bash
node scripts/issue-mcp-token.mjs --user <your uuid> --label "Colt · Claude Desktop"
```

Paste the `insert into mcp_tokens ...` it prints into the Supabase SQL editor.
Only the SHA-256 digest is stored, so the token itself is shown once and never
again.

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`),
using mcp-remote as the stdio-to-HTTP bridge:

```json
{
  "mcpServers": {
    "strength-log": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server",
        "--header",
        "Authorization:${STRENGTH_AUTH}"
      ],
      "env": { "STRENGTH_AUTH": "Bearer <that secret>" }
    }
  }
}
```

(The no-space `Authorization:${STRENGTH_AUTH}` form dodges a known mcp-remote
arg-escaping bug.)

Restart Claude Desktop, then smoke test in chat: "search exercises for
barbell squat" should hit `search_exercises`.

### Other MCP clients

The endpoint is a standard streamable-HTTP MCP server with static bearer auth,
which is the combination every client supports. There is nothing Claude-specific
about it.

- **claude.ai / ChatGPT custom connectors, MCP Inspector, anything else with a
  URL + key field.** Point it at the endpoint above and send the token as
  `Authorization: Bearer <token>`. Clients whose UI only offers an API-key field
  can send `x-api-key: <token>` instead; both are accepted.
- **Browser-based clients** work because the function answers CORS preflights
  and exposes the MCP transport headers. A connector that fails with an
  unexplained "cannot connect" is almost always a CORS problem, and
  `lib/protocol.test.ts` pins that behaviour.
- **Transport.** Stateless: POST JSON-RPC only. GET and DELETE answer `405` with
  `Allow: POST`, which is what the spec expects from a server that offers no
  resumable session, and clients fall back cleanly.

Verify any client by hand:

```bash
curl -sS https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server \
  -H "Authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**What this is not.** There is no OAuth here, so a client that insists on an
OAuth flow (rather than accepting a static key) cannot do one-click "add
connector" against this server. Adding that means running an authorization
server — endpoints, PKCE, dynamic client registration, a consent screen — which
is a real project and buys one thing: a nicer install for clients that refuse
API keys. Per-user tokens already give the multi-user identity; OAuth would only
change how a token is obtained.

## 4. Smoke test the analysis path (no UI needed)

In chat with Claude Desktop:

1. `set_training_max` for your main lifts.
2. Paste a coach screenshot, let Claude parse it, review the table it renders,
   then let it call `upsert_program` and, after your explicit ok,
   `confirm_program`.
3. Insert a fake session via `scripts/fixtures/fake-session.sql` (dashboard
   SQL editor, replace the user id placeholder) and ask Claude to analyze
   your last session. You should get e1RM, adherence, and rest analysis.

## 5. PWA

```bash
cd pwa
cp .env.example .env    # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev             # local test
npm run build           # deploy dist/ to any static host
```

Hosting: Cloudflare Pages or Vercel free tier, or Supabase hosting if
enabled on the project. Then open it on the phone, sign in with the magic
link, and add to home screen.

## Adding another user

Everything below is per-person. Nothing is shared except the exercise library,
which is the point of a library.

**1. Create the account.** Nothing to do, usually: sign-up is open, so they
enter their email on the login screen and the account is created on the spot.
To pre-create instead, Authentication → Users → Add user (their email). Either
way, copy the new UUID — the MCP token and timezone steps below need it.

**2. Give them the PWA.** Nothing to configure — the app is one deployment and
RLS scopes every read and write to whoever is signed in. They install it and
sign in with their own email. If they use a device you have signed into, the
device cache is cleared automatically when the signed-in user changes; unsynced
sets stay queued for whoever logged them and are never replayed as anyone else.

**3. Give them an MCP token** so Claude (or another client) can read their log:

```bash
node scripts/issue-mcp-token.mjs --user <their-uuid> --label "Sam · Claude Desktop"
```

It prints the token once, the SQL to activate it, and a ready-made client
config. Paste the `insert into mcp_tokens ...` into the Supabase SQL editor.
The token is stored only as a SHA-256 digest, so this is the one moment it is
readable — losing it costs a revoke and a re-issue, nothing more.

One token per person per client. To see what is live, or to revoke:

```sql
select label, user_id, created_at, last_used_at, revoked_at from mcp_tokens;
update mcp_tokens set revoked_at = now() where label = 'Sam · Claude Desktop';
```

**4. Set their timezone, only if it differs from the household default.**
`app_config.tz` is the deployment-wide default and covers everyone in one
house. A user who lives or moves elsewhere gets their own row:

```sql
insert into user_config (user_id, tz) values ('<their-uuid>', 'Europe/Berlin')
  on conflict (user_id) do update set tz = excluded.tz, updated_at = now();
```

This is deliberately SQL and not a settings toggle: it changes about once in a
lifetime, and the PWA's own settings are device-local by design (a per-user
server setting there would be a third write-ownership class — see CLAUDE.md).

### What is shared and what is not

| Thing                                               | Shared?                   |
| --------------------------------------------------- | ------------------------- |
| Sets, sessions, programs, training maxes, goals     | no                        |
| Custom exercises (`source = 'custom'`)              | no                        |
| Seeded exercise library (free-exercise-db, curated) | yes                       |
| `app_config.tz` (household default zone)            | yes, overridable per user |
| MCP tokens                                          | no, one identity each     |
| PWA device settings (plates, bars, rest, units)     | per device, not per user  |

That last row is the one to know: two people sharing one phone share its plate
inventory and per-exercise preferences. Two phones, no overlap.

## Env var reference

| Where                | Var                                           | What                                  |
| -------------------- | --------------------------------------------- | ------------------------------------- |
| Edge function secret | `MCP_SECRET`                                  | LEGACY single-user bearer token       |
| Edge function secret | `OWNER_USER_ID`                               | LEGACY user that `MCP_SECRET` maps to |
| Edge runtime (auto)  | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`   | injected by platform                  |
| PWA build            | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | public client creds                   |
| PWA build (optional) | `VITE_SENTRY_DSN`                             | error tracking; no-op if unset        |

`MCP_SECRET` / `OWNER_USER_ID` are the pre-multi-user credential: one secret
mapped to one person. They still work, so an existing Claude Desktop config
keeps running, but they cannot express a second user. Issue per-user tokens
instead (see "Adding another user") and delete both secrets once nothing uses
them:

```bash
supabase secrets unset MCP_SECRET OWNER_USER_ID
```
