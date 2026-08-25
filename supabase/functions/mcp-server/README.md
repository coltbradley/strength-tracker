# mcp-server

MCP server for the strength tracker, running as a Supabase Edge Function.
Streamable HTTP, stateless (every POST is independent, no session ids). Claude
connects through `mcp-remote` with a static bearer token and gets 8 tools: 4
read (exercises, lift history, sessions, goal progress) and 4 write (programs,
program confirmation, training maxes, goals). It can never write `sessions` or
`sets` — those belong to the PWA.

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
