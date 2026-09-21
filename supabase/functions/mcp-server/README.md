# mcp-server

MCP server for the strength tracker, running as a Supabase Edge Function.
Streamable HTTP, stateless (every POST is independent, no session ids). Claude
connects through `mcp-remote` with a **per-user** bearer token from
`scripts/issue-mcp-token.mjs` and gets 14 tools.

Read (`readOnlyHint`): `search_exercises`, `resolve_exercises` (the same
lookup for many names at once, in one round trip), `get_lift_history`,
`get_recent_sessions`, `get_checkins` (every check-in in full: note, energy,
tags, time of day, and the injury a pain check-in was filed against),
`get_checkin_buckets` (energy and tags per day and time of day, with counts),
`get_injuries` (injury episodes with their check-ins; quiet is not healed),
`get_goal_progress`.

Write: `upsert_program` (always unconfirmed), `confirm_program`,
`delete_program`, `set_training_max`, `set_goal`, `add_exercise`,
`update_exercise`, `delete_exercise`.

It can never write `sessions`, `sets`, `set_voids` or `set_notes`: those belong
to the PWA. See [docs/architecture.md](../../../docs/architecture.md) for what
each tool does.

## Env vars

| Var                         | Source                             |
| --------------------------- | ---------------------------------- |
| `SUPABASE_URL`              | Auto-injected by the edge runtime. |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by the edge runtime. |

Identity is the bearer token, not an env var: `mcp_tokens` maps its SHA-256
digest to a user. Mint and activate tokens per [docs/setup.md](../../../docs/setup.md)
step 3 (`issue-mcp-token.mjs`). The legacy shared `MCP_SECRET` /
`OWNER_USER_ID` pair is not accepted.

## Deploy

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

`--no-verify-jwt` is required: requests carry the MCP bearer token, not a
Supabase JWT. The function does its own auth (constant-time check) before
anything else.

The function reads one piece of database config: `app_config.tz`, the lifter's
home timezone. It is the same row the SQL views read through `app_tz()`, and it
decides what date `set_training_max` stamps by default. Cached per isolate;
change it and redeploy. See docs/setup.md step 5.

## Local checks

```bash
deno check index.ts   # typecheck the whole graph from the entrypoint
deno test --allow-env --allow-net  # full protocol, tool, and date suite
```

Both run in CI. `protocol.test.ts` sets test-only environment variables and
uses a closed local URL to exercise the unavailable-token-store path, hence the
explicit permissions. The SQL half of the date rules lives in
`scripts/validate-db.mjs`.

## Local serve

```bash
supabase functions serve mcp-server --env-file supabase/functions/.env
# endpoint: http://127.0.0.1:54321/functions/v1/mcp-server
```

Put `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `supabase/functions/.env`
for local serve (or rely on `supabase start`). Auth still needs a row in
`mcp_tokens` for the bearer you send.

## Smoke test with curl

Streamable HTTP requires `Accept: application/json, text/event-stream` on every
POST. Stateless mode means no session header anywhere. Use a minted per-user
token (not a deployment secret):

```bash
URL=http://127.0.0.1:54321/functions/v1/mcp-server
AUTH="Authorization: Bearer <mcp-token-from-issue-mcp-token>"
HDRS=(-H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

# initialize
curl -s "${HDRS[@]}" "$URL" -d '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "curl", "version": "0.0.0" }
  }
}'

# tools/list
curl -s "${HDRS[@]}" "$URL" -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'

# tools/call
curl -s "${HDRS[@]}" "$URL" -d '{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "search_exercises", "arguments": { "query": "squat" } }
}'
```

A request without the bearer token should return 401; a GET should return 405.
