# Group 07: MCP gateway, identity, and tunnel

## Scope and evidence

Inspected `supabase/functions/mcp-server/index.ts`; gateway auth, database client, OAuth, handler, health, errors, logging, and protocol/OAuth/health tests under `supabase/functions/mcp-server/lib/`; and the assigned token, OAuth spike, relay, supervisor, tunnel config, launchd template, and adjacent tunnel tests under `scripts/`. Read `AGENTS.md`, this audit's README, the active consolidated roadmap, the release ledger, and the earlier system-audit entries used as leads. Checks were source and test inspection with `nl -ba`, `rg`, and `git status`; no tests, network calls, live services, or real secrets were used.

## Executive summary

Five confirmed findings: three P1 and two P2. The top risks are unbounded request-body buffering at the public Edge endpoint, OAuth tokens accepted without a resource/scope check, and tunnel child processes that can stall when their unread stderr pipes fill. The relay also continues its upstream request after client disconnect, and early unauthenticated gateway routes lack request-level telemetry.

Rechecked leads: A-01's readiness contract now agrees (`waitForRelay` and relay both use `OPTIONS`/204, and the relay test invokes the real readiness check); A-149's legacy `MCP_SECRET` path is absent and the protocol test verifies its rejection. The release ledger records each as fixed with a test. A-31's runtime environment exposure remains present. A-51 and A-52 have handoffs below because their primary fixes are in consent UI and setup documentation.

## Findings

### G07-F01. The Edge handler buffers an unbounded request before parsing

- **Severity:** P1. **Confidence:** High.
- **Trigger:** Any authenticated client sends a very large or chunked POST body to the public MCP endpoint.
- **Evidence:** `supabase/functions/mcp-server/lib/handler.ts:254-263` calls `req.json()` before schema/protocol handling and has no declared-length or streamed byte limit. The registered tool schemas are applied only after this body has already been parsed by the SDK at lines 273–278.
- **Impact:** A caller can force high memory and CPU use in the Edge worker before tool-level validation, potentially making the gateway unavailable to other callers. This remains the request-side risk described by A-86; it is distinct from response-size limits in tool files.
- **Existing audit/ledger ID:** A-86 (prior audit; not listed in the current release ledger).
- **Suggested fix boundary:** `lib/handler.ts`; reject an excessive `Content-Length` and enforce the same maximum while reading the stream, including chunked bodies.
- **Verification needed:** Exercise oversized declared and chunked bodies through `handleRequestWithCaller`; both should return a bounded 413/JSON-RPC error without calling the MCP transport.

### G07-F02. OAuth validation does not bind a token to this resource or scope

- **Severity:** P1. **Confidence:** High for the missing check; practical exposure depends on the issuer's token/grant model.
- **Trigger:** Supabase Auth accepts a current OAuth token with `sub`, `role: authenticated`, and `client_id`, even when that token has no audience/resource or scope authorizing this MCP server.
- **Evidence:** `supabase/functions/mcp-server/lib/oauth.ts:57-65` turns those three payload claims into a full `Caller`. `verifyOAuthToken` at lines 106–151 asks `auth.getUser` whether the token is valid and checks only that its user ID matches `sub`; it does not validate issuer, audience/resource, or granted scopes. Every registered MCP tool is then exposed for that caller by `lib/handler.ts:70-125`.
- **Impact:** The gateway treats general OAuth identity as authority for the entire MCP tool surface. A token issued for another resource or with narrower permissions can therefore be elevated to MCP's read/write capabilities if the Auth server accepts it for `/user`. This is the resource-server boundary gap described by A-66.
- **Existing audit/ledger ID:** A-66 (prior audit; not listed in the current release ledger).
- **Suggested fix boundary:** `lib/oauth.ts` and the authorization-server configuration/consent contract. Require and validate the issuer-supported resource and permission grant before constructing `Caller`; if Supabase cannot issue this distinction, document and constrain the supported OAuth mode explicitly.
- **Verification needed:** Obtain tokens for this resource, a different resource, no resource, and narrower/no scopes; only the explicitly authorized MCP token should resolve to a caller. Confirm revocation still rejects it.

### G07-F03. Tunnel child stderr pipes are never drained

- **Severity:** P1. **Confidence:** High.
- **Trigger:** Either the relay or tunnel client writes enough diagnostics to fill its OS pipe buffer.
- **Evidence:** `scripts/strength-tunnel-supervisor.mjs:78-82` starts both children with `stderr: "pipe"`; no listener consumes either stream before the supervisor waits for exit at lines 84–85. The supervisor tests use fake children and do not emit stderr (`scripts/strength-tunnel-supervisor.test.mjs:20-57`).
- **Impact:** A child can block on stderr while remaining alive. The supervisor sees no exit and cannot restart it, so MCP traffic can stop while launchd still sees the supervisor process running. This is A-170 in the earlier audit.
- **Existing audit/ledger ID:** A-170 (prior audit; not listed in the current release ledger).
- **Suggested fix boundary:** `scripts/strength-tunnel-supervisor.mjs`; either inherit/discard stderr or continuously drain it into bounded logging without secrets.
- **Verification needed:** Use a child fixture that writes beyond pipe capacity and prove output is drained and a later child exit still triggers restart/cleanup.

### G07-F04. A disconnected MCP client does not abort its upstream request

- **Severity:** P2. **Confidence:** High for missing cancellation wiring; downstream work after disconnect should be verified in an integration test.
- **Trigger:** A caller disconnects after the relay has forwarded a request, including while an upstream response is being streamed.
- **Evidence:** `scripts/strength-mcp-relay.mjs:133-144` creates an abort controller used only for a 30-second timer while waiting for upstream headers. The timer is cleared immediately after `fetchImpl` returns at lines 145–146. There is no request/response close handler that aborts the upstream request; the upstream body is piped at lines 147–152.
- **Impact:** Upstream processing and response transfer are not explicitly cancelled when the caller goes away. This can waste Edge work and delay side effects or resource release for abandoned tool calls, matching A-32.
- **Existing audit/ledger ID:** A-32 (prior audit; not listed in the current release ledger).
- **Suggested fix boundary:** `scripts/strength-mcp-relay.mjs`; couple client disconnect/close to the upstream abort signal and cancel the upstream response body on teardown.
- **Verification needed:** Start a delayed upstream fixture, disconnect the relay client before headers and during a streamed body, and assert the upstream signal/body is cancelled in each case.

### G07-F05. Early unauthenticated routes bypass request-level logging

- **Severity:** P2. **Confidence:** High.
- **Trigger:** A health probe, browser preflight, or OAuth metadata request fails or behaves unexpectedly.
- **Evidence:** `supabase/functions/mcp-server/lib/handler.ts:183-193` defines request finalization, but `OPTIONS` returns at lines 198–200, `/health` at 205–209, and OAuth metadata at 213–218 before the finalizer is called. `lib/health.ts:35-37` emits only a generic health-ping failure line without the handler's request ID or route.
- **Impact:** These public availability and discovery paths cannot be correlated with request-level logs; routine probes also provide no success records. This preserves A-147's observability gap.
- **Existing audit/ledger ID:** A-147 (prior audit; not listed in the current release ledger).
- **Suggested fix boundary:** `lib/handler.ts` and `lib/health.ts`; record route, status, duration, and request ID for early returns without logging credentials or user data.
- **Verification needed:** Assert one structured log event for each early route on success and failure, with no bearer or user content.

## Opportunities

### G07-O01. Reduce runtime credential exposure to child processes

The supervisor reads secrets from Keychain and passes them in environment variables (`scripts/strength-tunnel-supervisor.mjs:104-132`). This keeps secrets out of tracked configuration and logs, but leaves them available in the environment of long-lived child processes and potentially to sufficiently privileged same-user process inspection. A-31 remains applicable. A safer local credential handoff may reduce this exposure, at the cost of extra IPC and lifecycle complexity. Justify that investment with a macOS same-user process-inspection test and confirm the tunnel client supports a non-environment credential source.

## Documentation gaps

- `supabase/functions/mcp-server/README.md:5-18` says the server offers 14 tools and lists only an older subset; the current handler registers the broader surface, and the protocol annotation inventory contains 42 tools (`lib/handler.ts:70-124`, `lib/protocol.test.ts:383-433`). Update the README's count and read/write inventory to match the current registered tools.
- `supabase/functions/mcp-server/README.md:24-34` lists only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, while OAuth verification also constructs a client using `SUPABASE_ANON_KEY` (`lib/oauth.ts:89-100`). State whether the Edge platform injects this key and list it as an OAuth runtime dependency.
- The same README says deployment auth checks are a “constant-time check” (`supabase/functions/mcp-server/README.md:42-44`), but current static-token auth hashes the supplied token and queries the digest through PostgREST (`lib/auth.ts:114-127`). Replace the claim with the actual digest lookup behavior.

## Handoffs

- **Group 06, shared UI:** Recheck A-51 in `pwa/src/screens/OAuthConsent.tsx`. The previous audit says consent copy omits the destructive authority now advertised by the gateway's full tool surface. The consent screen is outside group 07's owned source.
- **Group 13, release docs:** Recheck A-52 in `docs/setup.md`. The previous audit says hosted OAuth server and dynamic client registration prerequisites are omitted. Setup documentation is outside this group's owned source.

## Open questions and limits

- The resource/scope impact of A-66 depends on the exact claims and grant behavior of the currently configured Supabase OAuth server. No live issuer or production token was queried; obtain representative authorized and differently scoped tokens for the verification above.
- The tunnel findings are based on current local source and tests only. No installed launchd job, tunnel client, local Keychain item, or production Edge function was inspected or exercised.
- The body-size, relay cancellation, and logging findings were not run against the Supabase Edge runtime or a deployed endpoint.
