# mcp-server

MCP server for the strength tracker, running as a Supabase Edge Function.
Streamable HTTP, stateless (every POST is independent, no session ids). Claude
connects through `mcp-remote` with a static bearer token and gets 12 tools.

Read (`readOnlyHint`): `search_exercises`, `get_lift_history`,
`get_recent_sessions`, `get_goal_progress`.

Write: `upsert_program` (always unconfirmed), `confirm_program`,
`delete_program`, `set_training_max`, `set_goal`, `add_exercise`,
`update_exercise`, `delete_exercise`.

It can never write `sessions`, `sets`, `set_voids` or `set_notes`: those belong
to the PWA. See [docs/architecture.md](../../../docs/architecture.md) for what
each tool does.

## Env vars

| Var                         | Source                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MCP_SECRET`                | Function secret. Long random bearer token, same value as in Claude Desktop's mcp-remote `--header` config.  |
| `OWNER_USER_ID`             | Function secret. UUID of the single Supabase Auth user; every query filters and every write stamps this id. |
| `SUPABASE_URL`              | Auto-injected by the edge runtime.                                                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by the edge runtime.                                                                          |

Set secrets with `supabase secrets set MCP_SECRET=... OWNER_USER_ID=...`
(locally: put them in `supabase/functions/.env`).

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
deno test lib/        # date rules (lib/dates.test.ts)
```

Both run in CI. The SQL half of the date rules lives in
`scripts/validate-db.mjs`.

## Local serve

```bash
supabase functions serve mcp-server --env-file supabase/functions/.env
# endpoint: http://127.0.0.1:54321/functions/v1/mcp-server
```

## Smoke test with curl

Streamable HTTP requires `Accept: application/json, text/event-stream` on every
POST. Stateless mode means no session header anywhere.

```bash
URL=http://127.0.0.1:54321/functions/v1/mcp-server
AUTH="Authorization: Bearer $MCP_SECRET"
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
