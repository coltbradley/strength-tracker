# Strength Tracker tunnel relay design

## Goal

Make the existing Strength Tracker MCP server available through the same
private OpenAI Secure MCP Tunnel pattern used by Premiere Transcriber, without
putting a reusable Strength Tracker bearer token in ChatGPT or a tunnel-client
profile.

## Scope

This is a personal-machine integration. It creates a loopback-only relay and
a local supervisor. It does not change the public Supabase MCP endpoint, add
OAuth, expand the MCP tool list, or alter any database authorization rule.

## Architecture

`tunnel-client` connects to a relay bound to `127.0.0.1`. The relay accepts
only `POST /mcp` from a non-browser caller: no CORS headers, any request with
an `Origin` is refused, and the `Host` must be a loopback name. (The first
version answered CORS preflights with `*`, which let any web page on the Mac use
the relay's bearer; see docs/security.md.) It forwards the original
JSON-RPC body to the configured Strength Tracker MCP URL while discarding any
incoming authorization header and adding one fixed `Authorization: Bearer`
header.

The supervisor reads the Strength Tracker bearer and OpenAI tunnel runtime key
from the logged-in macOS user's Keychain, starts the relay with a minimal child
environment, then starts `tunnel-client` using a profile whose server URL is
the loopback relay. The profile stores only the OpenAI control-plane key
reference and tunnel ID. It never stores either secret.

```
ChatGPT custom app
        |
OpenAI Secure MCP Tunnel
        |
tunnel-client on this Mac
        |
127.0.0.1 relay -- injects Keychain token
        |
Supabase mcp-server -- resolves mcp_tokens user identity
```

## Security requirements

- The relay binds only to `127.0.0.1`; it must reject all other paths and
  methods.
- The upstream URL must use HTTPS and must exactly match the configured
  Strength Tracker Supabase MCP endpoint. Redirects are errors.
- The relay must never log authorization headers, token values, request
  bodies, or response bodies.
- The relay must replace, never forward, incoming `authorization` and
  `x-api-key` headers.
- Keychain items are the only persistent local storage for the Strength
  Tracker bearer and the tunnel runtime key. The tunnel profile and LaunchAgent
  plist may contain neither value.
- The relay forwards the upstream status, content type, cache policy, and body
  so MCP JSON and SSE responses stay protocol-compatible.
- Existing server-side ownership checks remain the authorization authority;
  the relay is transport and credential containment only.

## Operational requirements

- The supervisor starts the relay before `tunnel-client` and stops both on
  termination.
- If either child exits unexpectedly, the supervisor restarts the pair with
  bounded exponential backoff and writes only lifecycle events to stderr.
- A LaunchAgent keeps the supervisor running while the user is logged in.
- Setup documentation provides a reversible Keychain command, tunnel-profile
  creation command, LaunchAgent installation, health checks, and removal
  steps.
- Creating an OpenAI tunnel, creating its runtime API key, and saving a
  ChatGPT custom-app connection remain interactive account actions. They are
  not automated by this repository.

## Testing

Node's built-in test runner covers the relay with a local fake upstream:

- a POST reaches only the configured upstream and has the relay's bearer
  header, not the caller's header;
- non-loopback request paths and unsupported methods are rejected;
- upstream status and response headers are preserved;
- an HTTP upstream URL and an upstream redirect fail closed;
- logs do not contain tokens.

The MCP Edge Function's existing Deno protocol suite remains the regression
test for server-side authentication and tools.

## Non-goals

- OAuth or account linking.
- Direct exposure of the Supabase bearer in the ChatGPT UI.
- New write tools or writes to training sessions, sets, set voids, or notes.
- A route around ChatGPT product-level tool availability or confirmation
  controls.
