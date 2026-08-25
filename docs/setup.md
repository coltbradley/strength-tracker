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

4. Seed exercises (873 rows, idempotent, regenerate any time):

```bash
node scripts/build-exercise-seed.mjs
supabase db query < supabase/seed/exercises.generated.sql
```

If `supabase db query` isn't in your CLI version, paste the generated file
into the dashboard SQL editor. It's a single idempotent statement.

## 2. Your user

1. Authentication → Users → Add user (your email, or invite + magic link).
2. Copy the user's UUID. This is `OWNER_USER_ID`.

## 3. MCP server

```bash
# generate a long random secret
openssl rand -base64 32

supabase secrets set MCP_SECRET='<that secret>' OWNER_USER_ID='<user uuid>'
supabase functions deploy mcp-server --no-verify-jwt
```

Endpoint: `https://<PROJECT_REF>.supabase.co/functions/v1/mcp-server`

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

## Env var reference

| Where                | Var                                           | What                                    |
| -------------------- | --------------------------------------------- | --------------------------------------- |
| Edge function secret | `MCP_SECRET`                                  | bearer token Claude sends               |
| Edge function secret | `OWNER_USER_ID`                               | your auth.users uuid, stamps MCP writes |
| Edge runtime (auto)  | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`   | injected by platform                    |
| PWA build            | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | public client creds                     |
| PWA build (optional) | `VITE_SENTRY_DSN`                             | error tracking; no-op if unset          |
