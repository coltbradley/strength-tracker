# Decision log

Deviations from the original spec, with reasons. Newest last.

## 2026-08-25 auth: static bearer token via mcp-remote, not OAuth

The spec flagged MCP OAuth 2.1 on Supabase as the top risk and said to spike it
first. Spiked via research instead of code, findings:

- The claude.ai / Claude Desktop custom connector UI supports only OAuth (with
  dynamic client registration) or no auth. Static header entry is broken and
  the feature request was closed "not planned" (anthropics/claude-ai-mcp
  issues #112, #644).
- `mcp-remote` (geelen/mcp-remote) supports `--header "Authorization:Bearer x"`.
  It is the standard stdio-to-HTTP bridge for Claude Desktop and keeps the
  secret in local config, out of any cloud connector UI.
- Supabase officially documents MCP servers on Edge Functions with streamable
  HTTP, deployed with `--no-verify-jwt` so the function does its own auth.
- Supabase Auth does now ship an OAuth 2.1 server with DCR and PKCE
  (docs: guides/auth/oauth-server/mcp-authentication), so the claude.ai
  connector path exists if ever needed from mobile/web. It is overkill for one
  user and DCR is open registration by default, which is its own risk.

Decision: v1 auth is a long random bearer token stored in Claude Desktop's
config (via mcp-remote --header) and in the edge function's secrets
(MCP_SECRET). Constant-time comparison in the function. OAuth 2.1 documented
as the upgrade path, not built.

Consequence: the spec's line "Claude connects from Anthropic's cloud" is wrong
for this setup. mcp-remote runs locally and connects out, so the endpoint
technically only needs to be reachable from this machine. Keeping it on
Supabase public HTTPS anyway: it's free, and it keeps the claude.ai connector
door open.

## 2026-08-25 MCP writes use the service role pinned to one user id

MCP requests authenticate with the bearer token, not a Supabase Auth session,
so there is no `auth.uid()` on that path. The edge function uses the service
role key and stamps every write with the `OWNER_USER_ID` secret. Code in
`lib/db.ts` is the only place the service client is constructed, and every
tool query filters or stamps that user id. RLS still fully protects the PWA
path. Revisit if this ever becomes multi-user (it shouldn't).

## 2026-08-25 two extra write tools: set_training_max, set_goal

The spec's six tools leave `training_maxes` and `goals` with no write path at
all: the PWA has four screens (none is TM/goal entry) and Claude couldn't
write them either. Percentage-based prescriptions are unresolvable without a
TM row, and the spec itself says that's a hard requirement. Added two small
write tools. Both are low blast radius (no history, no training record).
Tool count is now eight.

## 2026-08-25 exercises keep the upstream slug as primary key

free-exercise-db ids are stable slugs (`Barbell_Squat`). Using them directly
makes seeds idempotent, programs readable in raw SQL, and re-seeding safe.
Custom exercises use the same slug format with `source = 'custom'`.
Verified upstream: 873 exercises, Unlicense, `dist/exercises.json` is the
committed artifact (the NDJSON make target exists but its output is not
committed, so the seed script transforms JSON itself, no jq dependency).

## 2026-08-25 append-only enforced by RLS, not just convention

`sets` has insert and select policies only. With RLS deny-by-default, update
and delete are impossible for the client no matter what the app code does.
`sessions` additionally gets update (ending a session edits the row) but no
delete. This is the mechanism, not a lint rule; do not add the missing
policies later without a decision entry here.

## 2026-08-25 client-generated UUIDs for sessions and sets

The offline queue replays inserts with `on conflict do nothing`. That is only
idempotent if the client owns the id. `sessions.id` and `sets.id` have no
database default on purpose; the PWA generates UUIDv4 at creation time.

## 2026-08-25 repo is public open source

Decided mid-build. Consequences, applied retroactively:

- No secrets, project refs, user uuids, emails, or personal identifiers
  anywhere in the repo. Secrets exist only in deployment (edge function
  secrets, local Claude Desktop config, PWA build env). The generated seed
  and all `.env*` files are gitignored.
- Security cannot rely on the code being private: docs/security.md holds the
  threat model and argues each layer (RLS floor, invoker-rights views,
  tool-surface-as-authorization, constant-time auth, confirm gate).
- Every non-obvious design choice gets a technical rationale in this file;
  the README fronts the five load-bearing claims. Open-source readers should
  be able to reconstruct the reasoning, not just the code.
- License: MIT for the code. Exercise seed data is Unlicense upstream
  (public domain), compatible, attributed in the README.

## 2026-08-25 database validated in PGlite, not a local Supabase stack

The dev machine has no Docker, so `supabase start` is unavailable, and
eyeballing 300 lines of SQL is not verification. `scripts/validate-db.mjs`
runs the real migrations, seed, and fixtures inside PGlite (Postgres compiled
to WASM, runs in Node) with a small shim for the `auth` schema
(`auth.users`, `auth.uid()` reading a session GUC) and an `authenticated`
role, then asserts view math and RLS behavior (append-only, cross-user
isolation). Not identical to the Supabase platform (no PostgREST layer, shim
instead of GoTrue), but it executes every line of committed SQL and the
core invariants. CI can run it with zero infrastructure.

## 2026-08-25 kg everywhere in storage, lb is display-only

Single unit in the database avoids a class of conversion bugs in views and
analytics. The PWA converts at the edge (display and steppers) with a
settings toggle. Plate rounding (nearest 2.5 kg / 5 lb) happens client-side
and in `v_resolved_prescriptions.plate_load_kg` for convenience.
