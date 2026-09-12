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

### Claude Code

Claude Code speaks streamable HTTP natively, so it needs no bridge. Add the
server at user scope, so every project sees it, with its own token (label it
`Colt · Claude Code` so it can be revoked on its own):

```bash
read -rs "STRENGTH_TOKEN?MCP token: "   # zsh; prompts without echoing or history
claude mcp add --scope user --transport http strength-log \
  https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server \
  --header "Authorization: Bearer $STRENGTH_TOKEN"
unset STRENGTH_TOKEN
```

Check with `claude mcp list` (it should say `connected`). In a session, ask it to
list your programs; that calls `list_programs`. The token is stored in
`~/.claude.json`, which is why it is a separate token from Claude Desktop's.

### Verifying a Claude setup

Both Claude clients were checked on 2026-09-12: Claude Desktop's configured
token answered `tools/list` with HTTP 200, and Claude Code's `strength-log`
server returned real programs from `list_programs`. To re-check a token
without printing it, use the curl below with the token read from its config.

### Other MCP clients

The endpoint is a standard streamable-HTTP MCP server with static bearer auth.
Most developer clients accept that directly. The consumer chat apps are the
exception, because their connector UIs are built around OAuth.

- **MCP Inspector, Cursor, or anything else with a URL + header field.** Point
  it at the endpoint above and send the token as
  `Authorization: Bearer <token>`. Clients whose UI only offers an API-key field
  can send `x-api-key: <token>` instead; both are accepted.
- **claude.ai (web, mobile).** A custom connector can carry a fixed
  `Authorization` or `x-api-key` header, but as of 2026-09 that option is in
  beta and set by an organization admin
  ([Anthropic docs](https://claude.com/docs/connectors/building/authentication)).
  Where it is not available, use Claude Desktop or Claude Code above.
- **ChatGPT.** Developer mode offers only OAuth or no authentication, with no
  field for a fixed header
  ([OpenAI docs](https://developers.openai.com/api/docs/guides/developer-mode)).
  Pointing it straight at this endpoint therefore cannot work. Use the tunnel
  below.
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

### ChatGPT through a Secure MCP Tunnel

This uses the same private-tunnel shape as Premiere Transcriber: ChatGPT sends
MCP requests to OpenAI's tunnel endpoint, `tunnel-client` runs on this Mac,
and the local relay adds the per-user Strength Tracker bearer before it reaches
Supabase. The bearer and the OpenAI runtime key live only in macOS Keychain.
Neither goes in the ChatGPT app, tunnel profile, or LaunchAgent.

Why a tunnel for a server that is already public: ChatGPT cannot send the
bearer (see above), and OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
is the documented way to give ChatGPT a server it cannot authenticate to
directly. Tunnel access is limited to the OpenAI organization and ChatGPT
workspace the tunnel is associated with. `tunnel-client`
([openai/tunnel-client](https://github.com/openai/tunnel-client)) documents no
way to add a header, which is why the relay exists. The alternative is OAuth on
the server, a real project (see "What this is not").

Know the costs before choosing it:

- **The Mac has to be awake and logged in.** Every ChatGPT surface reaches the
  log only while this Mac is running the LaunchAgent. OpenAI documents creating
  the app on web and does not say whether it then works on mobile.
- **Plan eligibility is not stated.** Developer mode is on Plus, Pro, Business,
  Enterprise and Edu (web). OpenAI does not say which of those can create
  tunnels; the tunnel needs Platform permissions `Tunnels Read + Manage` to
  create and `Tunnels Read + Use` to run. Check your account in step 1 before
  doing the rest.
- **The relay refuses browsers.** It sends no CORS headers and rejects any
  request with an `Origin` or a non-loopback `Host`, so a web page on this Mac
  cannot borrow the bearer. Only `tunnel-client` should talk to it.

1. In the OpenAI Platform tunnel settings, create a tunnel associated with the
   ChatGPT workspace where you will use it. Create a runtime API key for that
   tunnel. Do not use an admin API key.
2. Mint a new MCP token with a label such as `Colt · ChatGPT tunnel`; run its
   printed SQL in the Supabase dashboard. Copy the token once, then save it in
   Keychain:

   ```bash
   security add-generic-password -U -s "Strength Tracker MCP" -a "strength-tracker" -w
   security add-generic-password -U -s "OpenAI Tunnel Runtime" -a "strength-tracker" -w
   ```

   Each prompts for the value. Leaving `-w` last with nothing after it is
   deliberate: a value typed on the command line lands in shell history and is
   visible to `ps` while the command runs.

3. Copy `scripts/strength-tunnel-client.yaml.example` to
   `~/.config/tunnel-client/strength-tracker.yaml`. Replace only
   `tunnel_REPLACE_ME` with the created tunnel ID. Keep
   `api_key: "env:CONTROL_PLANE_API_KEY"` unchanged.
4. Copy `scripts/com.strength-tracker.mcp-tunnel.plist.template` to
   `~/Library/LaunchAgents/com.strength-tracker.mcp-tunnel.plist`. Replace the
   five `__...__` placeholders with the absolute repository path, the output
   of `command -v node`, the home directory, the existing shell PATH, the
   deployed Supabase project reference, and the absolute `tunnel-client` path.
   Create `~/Library/Logs/StrengthTracker` before loading it.
5. Check the profile, then install and start the LaunchAgent:

   ```bash
   tunnel-client doctor --profile strength-tracker --explain
   plutil -lint ~/Library/LaunchAgents/com.strength-tracker.mcp-tunnel.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.strength-tracker.mcp-tunnel.plist
   launchctl kickstart -k gui/$(id -u)/com.strength-tracker.mcp-tunnel
   tunnel-client health --port 8787 --require-control-plane-poll
   ```

6. In ChatGPT web, turn on developer mode (Settings → Security and login →
   Developer mode; on Business/Enterprise/Edu a workspace admin must allow it
   first). Then open ChatGPT Plugins, select **+** to create a developer-mode
   app, choose **Tunnel** under **Connection**, select the tunnel or paste its
   `tunnel_id`, scan the tools, then create the app. Menu names move; the
   [developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode)
   is the current source. Test a read tool first, then
   a low-blast-radius write such as `set_goal`; ChatGPT may require confirmation
   before a write.
7. Verify the pieces separately if the app cannot connect. The relay should
   answer a local, header-free call and refuse a browser-shaped one:

   ```bash
   curl -sS http://127.0.0.1:8786/mcp -H "content-type: application/json" \
     -H "accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 200
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8786/mcp \
     -H "origin: https://example.com" -d '{}'          # expect 403
   tail -n 20 ~/Library/Logs/StrengthTracker/*.log
   ```

   A good first call and a failing app means the tunnel half: re-run
   `tunnel-client doctor` and `tunnel-client health`. A 401 from the first call
   means the Keychain token is wrong or revoked.

To undo the connection, remove the ChatGPT app, then run:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.strength-tracker.mcp-tunnel.plist
rm ~/Library/LaunchAgents/com.strength-tracker.mcp-tunnel.plist
security delete-generic-password -s "Strength Tracker MCP" -a "strength-tracker"
security delete-generic-password -s "OpenAI Tunnel Runtime" -a "strength-tracker"
```

Finally revoke the `Colt · ChatGPT tunnel` row in `mcp_tokens` using the SQL
printed by `scripts/issue-mcp-token.mjs`. The public MCP endpoint stays online
for other clients.

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

Hosting: **GitHub Pages**, published by `.github/workflows/deploy.yml` on every
push to main. That is the actual deployment, not a suggestion -- see
[deploy.md](deploy.md), which gates the Supabase migration job in FRONT of the
Pages publish so the client can never ship ahead of its schema.

(An earlier draft of this line offered Cloudflare Pages or Vercel as
alternatives. Any static host still serves `dist/`, but two things are built
around Pages specifically: the app is served from a SUBPATH, which `PAGES_BASE`
threads through the router and the service worker scope, and the
migrations-before-publish ordering lives in that workflow. Moving hosts means
redoing both, not changing a deploy target.)

Then open it on the phone, sign in with the magic link, and add to home screen.

## Adding another user

Everything below is per-person. Nothing is shared except the exercise library,
which is the point of a library.

**1. Create the account.** Nothing to do, usually: sign-up is open by default,
so they enter their email on the login screen and the account is created on the
spot. To pre-create instead, Authentication → Users → Add user (their email).
Either way, copy the new UUID — the MCP token and timezone steps below need it.

Open sign-up is a convenience for exactly this step and a liability every other
day of the year, because the coach spends the deployment owner's money. Close
it once the people you meant to add are added: "Who can sign up, and who gets
the coach" below.

**2. Give them the PWA.** Nothing to configure — the app is one deployment and
RLS scopes every read and write to whoever is signed in. They install it and
sign in with their own email. If they use a device you have signed into, the
device cache is cleared automatically when the signed-in user changes; unsynced
sets stay queued for whoever logged them and are never replayed as anyone else.

**3. Give them an MCP token** so Claude (or another client) can read their log:

```bash
node scripts/issue-mcp-token.mjs --user <their-uuid> --label "Sam · Claude Desktop" \
  --project-ref <your-project-ref>
```

It prints the token once, the SQL to activate it, and a ready-made client
config. Paste the `insert into mcp_tokens ...` into the Supabase SQL editor.
Pass `--project-ref` (or export `SUPABASE_PROJECT_REF`) so the printed config
carries the real URL: without it the output says `<project-ref>` and whoever you
hand it to has to be told what to replace, which is the step people get stuck
on. What they paste into `claude_desktop_config.json` should work unedited.
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
| Custom exercises (`source = 'custom'`)              | no, one owner each        |
| Seeded library (free-exercise-db, curated, edited)  | yes                       |
| `app_config.tz` (household default zone)            | yes, overridable per user |
| MCP tokens                                          | no, one identity each     |
| PWA device settings (plates, bars, rest, units)     | per device, not per user  |

That last row is the one to know: two people sharing one phone share its plate
inventory and per-exercise preferences. Two phones, no overlap.

## Connecting an endurance source (optional)

The endurance layer takes activities from intervals.icu, from Strava, from both,
or from neither. Neither is a supported state: the views are simply empty and
nothing else in the app changes.

**intervals.icu is the one to connect first.** Free, an instant API key from
Settings -> Developer Settings, and it already carries whatever watch you own
(Garmin, Polar, Suunto, Coros, Oura, Whoop). It also carries elevation LOSS,
which Strava's activity list does not, and the endurance layer is built around
descent.

```sql
insert into integration_credentials (user_id, provider, secret, external_id)
values ('<uuid>', 'intervals_icu',
        '{"api_key":"<key>"}'::jsonb, '<athlete id, like i123456>');
```

**Strava is supported and is not the default.** Read
[endurance-research.md](endurance-research.md) first: the 2026 Standard tier
caps at about ten users, requires the developer to hold a paid Strava
subscription, allows roughly 100 reads per 15 minutes, and bars use of the data
in AI models. None of that stops a personal deployment; all of it is your call.

```sql
insert into integration_credentials (user_id, provider, secret)
values ('<uuid>', 'strava', '{"access_token":"<token>"}'::jsonb);
```

Then pull:

```bash
# everything (defaults to 400 days)
curl -X POST "$FUNCTIONS_URL/endurance-sync/backfill" \
  -H "Authorization: Bearer <a supabase session jwt>" -d '{}'

# just what is new, re-reading a 48h window because upstream activities get
# edited after upload
curl -X POST "$FUNCTIONS_URL/endurance-sync/poll" \
  -H "Authorization: Bearer <a supabase session jwt>"
```

The response reports each provider separately: `not_connected`, `disabled`,
`ok`, or `failed` with the reason. One provider failing never stops the other,
and nothing connected is a 200 rather than an error.

**Check `inserted_with_descent` on the first backfill.** It is reported for a
reason: if a full backfill lands zero descent measurements, the eccentric and
descent rules later in the plan have nothing to gate on, and it is much better
to find that out now than in E5. A Strava-only connection will always report
zero here, because Strava's activity list carries gain only.

Connecting both is fine and does not double-count. A before-insert trigger
marks the second copy of the same effort as `duplicate_of` the first, and
`v_live_activities` drops it. Both rows are kept, because each still holds its
own source's detail.

To disconnect: `update integration_credentials set enabled = false where ...`,
or delete the row. Activities already synced stay.

## Sign-in email (AgentMail SMTP)

Sign-in codes go out over AgentMail rather than a personal Gmail. A Gmail app
password is a credential to that entire account, the sender is a human being's
address, and Google's send limits are shaped for a person rather than an app.

`supabase/config.toml` already points at it; the credentials come from
`.env.local` (gitignored) and are applied with `scripts/push-auth-config.sh`:

```
SMTP_USER=<inbox>@agentmail.to
SMTP_PASS=<an AgentMail API key, Dashboard -> API Keys>
```

Three things that are easy to get wrong:

**Use a dedicated inbox.** AgentMail requires the From address to match the
inbox it authenticates as, so `SMTP_USER` *is* the sender. Do not reuse an
existing research or listening inbox: its deliverability reputation is the wrong
one for auth mail, and a friend receiving a login code from an unfamiliar alias
reads it as phishing. Make one for this app.

**The password is an API key, not a mailbox password.** Dashboard -> API Keys.

**Port 587 needs STARTTLS before AUTH**; authenticating first is rejected with a
538. If sign-in mail starts failing that way, switch `port` to 465 (implicit
TLS) in `config.toml`. Both are supported; 587 is set because it is what the
previous Gmail config used.

## Who can sign up, and who gets the coach

Two settings, and they only make sense together. Sign-up is open by default,
which is what makes step 1 above a no-op. The coach's spend limit is PER USER
(150 turns a day), so it caps what one account can cost and says nothing at all
about how many accounts there are. Open sign-up plus a per-user quota means a
stranger who finds the function URL can make an account and run 150 turns a day
on the Anthropic key belonging to whoever deployed this.

**Close sign-up once everyone is in.** Dashboard → Authentication → Sign In /
Providers → Email (older dashboards: Authentication → Providers → Email), turn
off "Allow new users to sign up". Existing users keep signing in with magic
links exactly as before; new accounts now have to be created by you, which is
the Authentication → Users → Add user path step 1 already describes.

**Allowlist the coach**, separately, so that an account you create for the PWA
is not automatically a coach account:

```bash
supabase secrets set COACH_ALLOWED_USERS="<uuid>,<uuid>"
supabase functions deploy coach
```

**Switch the coach off for one person**, without touching anyone else:

```sql
insert into coach_access (user_id, enabled, reason)
values ('<their-uuid>', false, 'paused while we sort out the API bill')
  on conflict (user_id) do update
    set enabled = excluded.enabled,
        reason  = excluded.reason,
        updated_at = now();
```

Back on: `update coach_access set enabled = true, reason = null where user_id = '<uuid>'`.

NO ROW MEANS ON, so this table changed nothing for anyone when it landed. The
`reason` is shown to the person, so write it for them. The app reads their own
row and hides the chat button rather than offering one that answers 403; the
edge function enforces it either way, and a read that FAILS is answered 503
rather than treated as a refusal.

This is deliberately not a column on `user_config`: that table lets a user
update their own row, and a switch its subject can flip is not an
administrative control. It is also separate from `COACH_ALLOWED_USERS`, and
both must pass. The env var is the DOOR (checked before any database read, so
an open sign-up cannot mint accounts that spend your Anthropic key); this is
the SWITCH (per person, reversible, and visible to the app).

The MCP server is unaffected. Somebody switched off here still reads and writes
their own log from Claude Desktop with their bearer token — this controls who
spends the deployment's Anthropic key, not who owns their data.

Unset — the default — means everyone who can sign in can use the coach, so an
existing deployment behaves exactly as it did before this variable existed.
Set, and anyone not named gets a 403 and a plain "the coach isn't enabled for
this account" instead of a turn, before anything is spent or recorded. There is
no append: adding someone means re-setting the whole list. The per-user quota
still applies on top; the allowlist decides who has one.

Both, not either. Closing sign-up stops the account existing. The allowlist
stops an account that does exist — one you created for the PWA, or one made
before you closed the door — from reaching the API key.

## Error tracking (optional)

Both edge functions report to Sentry when a DSN is configured and do nothing
whatsoever when it is not: no init, no network call, and the SDK is never even
loaded. Local runs and CI need no DSN. (The PWA has its own, set at build time
— `VITE_SENTRY_DSN` — and the same no-op-if-unset rule.)

```bash
supabase secrets set SENTRY_DSN="https://<key>@<org>.ingest.sentry.io/<project>"
supabase functions deploy mcp-server --no-verify-jwt
supabase functions deploy coach
```

What goes up is the exception plus operational tags: request id, JSON-RPC
method, tool name, the user as a bare uuid, and which stage of a coach turn
failed. Never a prompt, an answer, an attachment name, a set or an exercise
name. Storing the conversation is a separate, deliberate decision with its own
switch (`coach_usage`, `COACH_LOG_CONTENT`), and Sentry is not allowed to
become a second copy of it that nobody chose. The structured JSON logs keep
everything they always had; this is added alongside them, for the days the
dashboard's analytics are the thing that is down.

## Env var reference

| Where                     | Var                                           | What                                                 |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Edge function secret      | `ANTHROPIC_API_KEY`                           | the coach's key; the coach 503s without it           |
| Edge fn secret (optional) | `COACH_ALLOWED_USERS`                         | uuids that may use the coach; everyone if unset      |
| Edge fn secret (optional) | `COACH_LOG_CONTENT`                           | `off` stops storing prompts/answers in `coach_usage` |
| Edge fn secret (optional) | `SENTRY_DSN`                                  | error tracking for both functions; no-op if unset    |
| Edge function secret      | `MCP_SECRET`                                  | LEGACY single-user bearer token                      |
| Edge function secret      | `OWNER_USER_ID`                               | LEGACY user that `MCP_SECRET` maps to                |
| Edge runtime (auto)       | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`   | injected by platform                                 |
| PWA build                 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | public client creds                                  |
| PWA build (optional)      | `VITE_SENTRY_DSN`                             | error tracking; no-op if unset                       |
| GitHub Actions secret     | `SUPABASE_ACCESS_TOKEN`                       | lets `deploy.yml` push migrations + functions; skipped if unset |
| GitHub Actions secret     | `SUPABASE_DB_PASSWORD`                        | `db push` needs Postgres itself, not just the API    |
| GitHub Actions variable   | `SUPABASE_PROJECT_REF`                        | which project the workflow links; not secret, still not in the repo |

`MCP_SECRET` / `OWNER_USER_ID` are the pre-multi-user credential: one secret
mapped to one person. They still work, so an existing Claude Desktop config
keeps running, but they cannot express a second user. Issue per-user tokens
instead (see "Adding another user") and delete both secrets once nothing uses
them:

```bash
supabase secrets unset MCP_SECRET OWNER_USER_ID
```
