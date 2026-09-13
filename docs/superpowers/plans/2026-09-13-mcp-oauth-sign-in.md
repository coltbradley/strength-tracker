# MCP OAuth sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ChatGPT (paid plans), claude.ai and Claude Desktop connect to the Strength Log MCP server by signing in with the normal Strength Log account, instead of pasting a minted bearer token or running a tunnel.

**Architecture:** Supabase Auth's OAuth 2.1 server (beta) is the authorization server: it serves discovery, dynamic client registration and token issuance. The `mcp-server` edge function becomes an OAuth _resource server_: it publishes RFC 9728 protected-resource metadata, points every 401 at it, and accepts Supabase-issued OAuth access tokens as a second way into `resolveCaller`, next to the existing `mcp_tokens` path, which is untouched. The PWA hosts the consent page Supabase redirects to, and Settings gains a "Connected apps" list that can revoke a grant.

**Tech Stack:** Deno edge function (`@supabase/supabase-js@^2`, `@modelcontextprotocol/sdk@^1.25`), React + Vite PWA (`@supabase/supabase-js` 2.112.4, whose `auth.oauth` exposes `getAuthorizationDetails`, `approveAuthorization`, `denyAuthorization`, `listGrants`, `revokeGrant`), Vitest, `deno test`.

## Global Constraints

- The token IS the identity. Never cache a `Db`, a user id, or anything derived from one at module scope; build per request (CLAUDE.md "Identity").
- MCP tools never write `sets`, `sessions`, `set_voids` or `set_notes`. Nothing in this plan adds a write path.
- "We could not find out" is never "no": an auth server that cannot be reached is **503**, a token it rejects is **401** (matches `auth_lookup_failed` in `lib/auth.ts`).
- Existing credentials keep working unchanged: `stl_…` tokens, the coach's per-turn `uuid+uuid` tokens, and the legacy `MCP_SECRET`.
- Only OAuth-issued tokens are accepted on the new path: a JWT with no `client_id` claim (a plain PWA session token) is **401**. The MCP server runs as the service role and bypasses RLS, so a session token lifted from a browser must not become an MCP credential.
- This repository is public. No secret, token or project key value in code, docs, commits or logs. Log the OAuth `client_id`, never the token.
- Errors are never swallowed: edge function logs structured JSON via `lib/log.ts`; PWA reports via `pwa/src/lib/errors.ts`.
- PWA: one stylesheet (`pwa/src/styles.css`), colours only through tokens, text AA contrast, no new colour literals.
- Commits: `git add` explicit paths only, never `-A`. Pushing `main` deploys (CI runs `db push`, deploys all functions, publishes Pages).
- Verification commands: `deno check index.ts` and `deno test --allow-env --allow-net` in `supabase/functions/mcp-server`; `npm test -- --run`, `npm run typecheck` (never `tsc --noEmit`, it checks zero files), `npm run build` in `pwa/`.
- Resource URL is `${SUPABASE_URL}/functions/v1/mcp-server`; authorization server issuer is `${SUPABASE_URL}/auth/v1`.

## File map

| File                                                          | Responsibility                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/oauth-spike.mjs` (create)                            | Dev utility: runs the OAuth flow against the real project with PKCE, prints claims (never the token), optionally calls the MCP server. Used by Task 1 and Task 6. |
| `supabase/functions/mcp-server/lib/oauth.ts` (create)         | JWT detection, payload decode, claims → `Caller`, token verification via `auth.getUser`, protected-resource metadata.                                             |
| `supabase/functions/mcp-server/lib/oauth.test.ts` (create)    | Unit tests for the above with an injected `getUser`.                                                                                                              |
| `supabase/functions/mcp-server/lib/auth.ts` (modify)          | Route JWT-shaped tokens to `oauth.ts`; 401 carries `resource_metadata`.                                                                                           |
| `supabase/functions/mcp-server/lib/handler.ts` (modify)       | Serve metadata before auth.                                                                                                                                       |
| `supabase/functions/mcp-server/lib/protocol.test.ts` (modify) | Interop tests for discovery, 401 header, 503 on unreachable auth, annotations.                                                                                    |
| `supabase/functions/mcp-server/tools/*.ts` (modify)           | Explicit `readOnlyHint` / `destructiveHint` / `openWorldHint` on all 33 tools.                                                                                    |
| `pwa/src/lib/oauthConsent.ts` (create)                        | Pure helpers: consent-path detection, authorization id parsing, redirect host.                                                                                    |
| `pwa/src/lib/oauthConsent.test.ts` (create)                   | Tests for the helpers.                                                                                                                                            |
| `pwa/src/screens/OAuthConsent.tsx` (create)                   | Consent screen.                                                                                                                                                   |
| `pwa/src/screens/OAuthConsent.test.tsx` (create)              | Consent screen tests.                                                                                                                                             |
| `pwa/src/components/ConnectedApps.tsx` (create)               | Settings section listing grants with Disconnect.                                                                                                                  |
| `pwa/src/components/ConnectedApps.test.tsx` (create)          | Tests.                                                                                                                                                            |
| `pwa/src/App.tsx` (modify)                                    | Render `OAuthConsent` instead of the shell on the consent path.                                                                                                   |
| `pwa/src/components/SettingsSheet.tsx` (modify)               | Mount `ConnectedApps`.                                                                                                                                            |
| `pwa/src/styles.css` (modify)                                 | Consent layout rules.                                                                                                                                             |
| `supabase/config.toml` (modify)                               | Mirror the OAuth server settings for local dev.                                                                                                                   |
| `docs/decisions.md`, `docs/setup.md`, `CLAUDE.md` (modify)    | Record the decision, replace the connection instructions, update the identity rule.                                                                               |

---

### Task 1: Spike the hosted OAuth server before writing product code

This task is a gate. It proves four facts the rest of the plan depends on, against the real project, and records them. No product code lands until it passes.

**Files:**

- Create: `scripts/oauth-spike.mjs`
- Modify: `docs/decisions.md` (prepend an entry)

**Interfaces:**

- Produces: `node scripts/oauth-spike.mjs [--mcp]`, used again in Task 6.

- [ ] **Step 1: Colt enables the OAuth server (manual, dashboard)**

In the Supabase dashboard for project `idjjdmtgchcpwqmtkoza`: Authentication → OAuth Server → enable; enable "Allow dynamic client registration"; leave the authorization path at its default `/oauth/consent`. Site URL stays `https://coltbradley.github.io/strength-tracker/`.

- [ ] **Step 2: Write the spike script**

```js
#!/usr/bin/env node
// Runs one OAuth 2.1 authorization-code + PKCE flow against the project's
// Supabase Auth OAuth server, the way ChatGPT and claude.ai will, and prints
// what came back. It exists to prove facts about a BETA server before code
// depends on them, and to test the MCP server end to end afterwards.
//
// It never prints or writes the access token. Claims only.
//
//   node scripts/oauth-spike.mjs            # discovery, register, sign in, claims
//   node scripts/oauth-spike.mjs --mcp      # ...then call tools/list with the token
//
// Needs SUPABASE_URL in the environment (the project URL, not a key).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const base = process.env.SUPABASE_URL;
if (!base) {
  console.error("Set SUPABASE_URL=https://<ref>.supabase.co");
  process.exit(1);
}
const callMcp = process.argv.includes("--mcp");
const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const discoveryUrl = `${base}/.well-known/oauth-authorization-server/auth/v1`;
const discovery = await (await fetch(discoveryUrl)).json();
console.log("issuer:", discovery.issuer);
console.log("authorization_endpoint:", discovery.authorization_endpoint);
console.log("token_endpoint:", discovery.token_endpoint);
console.log("registration_endpoint:", discovery.registration_endpoint);

const reg = await fetch(discovery.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Strength Log OAuth spike",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const client = await reg.json();
if (!reg.ok) {
  console.error("registration failed:", reg.status, client);
  process.exit(1);
}
console.log("registered client_id:", client.client_id);

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));
const authorize = new URL(discovery.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
}).toString();

console.log(
  "\nOpen this in a browser and WATCH THE URL BAR after it redirects:",
);
console.log(authorize.toString(), "\n");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Done. Return to the terminal.");
    server.close();
    if (url.searchParams.get("state") !== state)
      return reject(new Error("state mismatch"));
    const err = url.searchParams.get("error");
    if (err) return reject(new Error(`authorization denied: ${err}`));
    resolve(url.searchParams.get("code"));
  });
  server.listen(PORT, "127.0.0.1");
});

const tokenRes = await fetch(discovery.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok) {
  console.error(
    "token exchange failed:",
    tokenRes.status,
    tokens.error,
    tokens.error_description,
  );
  process.exit(1);
}
const [headerPart, payloadPart] = tokens.access_token.split(".");
const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
console.log("jwt alg:", header.alg);
console.log("claims:", {
  iss: claims.iss,
  aud: claims.aud,
  sub: claims.sub,
  role: claims.role,
  client_id: claims.client_id,
  session_id: claims.session_id,
  lifetime_s: claims.exp - claims.iat,
});
console.log("refresh_token issued:", Boolean(tokens.refresh_token));

const user = await fetch(`${base}/auth/v1/user`, {
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    apikey: process.env.SUPABASE_ANON_KEY ?? "",
  },
});
console.log("GET /auth/v1/user with the OAuth token:", user.status);

if (callMcp) {
  const mcp = await fetch(`${base}/functions/v1/mcp-server`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await mcp.json();
  console.log(
    "MCP tools/list:",
    mcp.status,
    Array.isArray(body?.result?.tools)
      ? `${body.result.tools.length} tools`
      : body,
  );
}

console.log(
  "\nTo test revocation: disconnect this client in the app (or dashboard),",
);
console.log(
  "then run the /auth/v1/user check again within the token's lifetime.",
);
```

- [ ] **Step 3: Run it and record the four facts**

Run: `SUPABASE_URL=https://idjjdmtgchcpwqmtkoza.supabase.co SUPABASE_ANON_KEY=<anon key from pwa/.env> node scripts/oauth-spike.mjs`

Record in a scratch note:

1. **Consent redirect target.** After opening the authorize URL, the browser lands on either `https://coltbradley.github.io/strength-tracker/oauth/consent?authorization_id=…` (PASS) or `https://coltbradley.github.io/oauth/consent?…` (the open bug supabase/auth#2408). The page will not work yet (Task 3 builds it); only the URL matters. Note it and stop the script with Ctrl-C. Facts 2–4 need a working consent page, so they are completed in Task 3, Step 13.
2. **Claims.** `client_id` is present, `sub` is the user id, `role` is `authenticated`.
3. **`GET /auth/v1/user` returns 200** with the OAuth token (this is what `lib/oauth.ts` relies on).
4. **Revocation.** After `revokeGrant` for the spike client, `/auth/v1/user` with the same token returns 401 (immediate) or 200 until `exp` (delayed). Record `lifetime_s`.

- [ ] **Step 4: Apply the gate**

- Fact 1 PASS → continue.
- Fact 1 lands at the site root → STOP and ask Colt to choose: (a) wait for supabase/auth#2408; (b) create the `coltbradley/coltbradley.github.io` repository with one file `oauth/consent/index.html` containing
  ```html
  <!doctype html><meta charset="utf-8" /><title>Strength Log</title>
  <script>
    location.replace("/strength-tracker/oauth/consent" + location.search);
  </script>
  ```
  which forwards to the real consent page. Creating a public repo is Colt's call, not the implementer's.
- Fact 2 missing `client_id` → STOP: the "OAuth tokens only" constraint cannot be enforced by claim; bring back to Colt.
- Fact 3 not 200 → switch `verifyOAuthToken` in Task 2 to `auth.getClaims(token)` and note that revocation then waits for `exp`.

- [ ] **Step 5: Record the decision**

Prepend to `docs/decisions.md` (below the title, above `## 2026-09-12 ChatGPT private access…`), filling the bracketed values with what Step 3 observed:

```markdown
## 2026-09-13 MCP clients sign in with Supabase OAuth; tokens and the tunnel stay as fallbacks

Supersedes the "OAuth documented as the upgrade path, not built" consequence of
2026-08-25. ChatGPT developer mode and claude.ai connectors only offer OAuth or
no auth, so every non-Desktop client needed a pasted token plus a relay
(2026-09-12). Supabase Auth now ships an OAuth 2.1 server (beta, free on all
plans) with discovery, dynamic client registration and PKCE, so the edge
function only has to be a resource server.

Spike against the hosted project, 2026-09-13:

- Consent redirect landed on [URL observed].
- Access token: alg [alg], claims include client_id and sub; lifetime [n] s;
  refresh token [issued / not issued].
- GET /auth/v1/user accepts the OAuth token: [status].
- Revoking the grant [invalidates the token immediately / leaves it valid until exp].

Decision: `resolveCaller` accepts a JWT only when it carries `client_id`, and
verifies it with `auth.getUser` (one round trip, the same cost class as the
`mcp_tokens` lookup, and server-side so revocation is honoured [immediately /
at exp]). A plain session JWT is refused: the server runs as the service role,
so a browser session token must not double as an MCP credential. Dynamic
registration is open by design; the gate is the lifter's own sign-in plus an
explicit Approve on a consent page that names the client and its redirect host.
Static tokens, the coach's short-lived tokens and the tunnel keep working.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/oauth-spike.mjs docs/decisions.md
git commit -m "Spike Supabase OAuth for MCP sign-in and record the findings"
```

---

### Task 2: Accept OAuth access tokens in the MCP server and advertise discovery

**Files:**

- Create: `supabase/functions/mcp-server/lib/oauth.ts`
- Create: `supabase/functions/mcp-server/lib/oauth.test.ts`
- Modify: `supabase/functions/mcp-server/lib/auth.ts` (the `unauthorized` helper and the top of `resolveCaller`)
- Modify: `supabase/functions/mcp-server/lib/handler.ts` (before the `// Auth before anything else.` block)
- Modify: `supabase/functions/mcp-server/lib/protocol.test.ts`

**Interfaces:**

- Consumes: `Caller` from `lib/auth.ts` (`{ userId: string; label: string }`), `log` from `lib/log.ts`.
- Produces:
  - `looksLikeJwt(token: string): boolean`
  - `decodeJwtPayload(token: string): Record<string, unknown> | null`
  - `callerFromClaims(claims: Record<string, unknown>): Caller | null`
  - `type GetUser = (token: string) => Promise<{ data: { user: { id: string } | null }; error: { status?: number; name?: string } | null }>`
  - `verifyOAuthToken(token: string, requestId: string, getUser?: GetUser): Promise<Caller | "rejected" | "unavailable">`
  - `resourceUrl(): string`, `resourceMetadataUrl(): string`, `protectedResourceMetadata(): Record<string, unknown>`

- [ ] **Step 1: Write the failing unit tests**

Create `supabase/functions/mcp-server/lib/oauth.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@^1";

Deno.env.set("SUPABASE_URL", "https://ref.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "anon-not-used-here");

const {
  callerFromClaims,
  decodeJwtPayload,
  looksLikeJwt,
  protectedResourceMetadata,
  resourceMetadataUrl,
  verifyOAuthToken,
} = await import("./oauth.ts");

const USER = "00000000-0000-4000-8000-000000000002";

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) =>
    btoa(JSON.stringify(v))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "ES256", typ: "JWT" })}.${enc(payload)}.signature`;
}

Deno.test("existing credential shapes are never mistaken for a JWT", () => {
  assertEquals(looksLikeJwt("stl_" + "A".repeat(43)), false);
  assertEquals(looksLikeJwt(crypto.randomUUID() + crypto.randomUUID()), false);
  assertEquals(looksLikeJwt("test-secret-do-not-use"), false);
  assertEquals(looksLikeJwt(jwt({ sub: USER })), true);
});

Deno.test("a payload that is not JSON decodes to null, not a throw", () => {
  assertEquals(decodeJwtPayload("aaa.bm90IGpzb24.sig"), null);
  assertEquals(decodeJwtPayload(jwt({ sub: USER }))?.sub, USER);
});

Deno.test(
  "only an OAuth token with a client and a user becomes a caller",
  () => {
    assertEquals(
      callerFromClaims({ sub: USER, role: "authenticated", client_id: "c1" }),
      { userId: USER, label: "oauth client c1" },
    );
    // A plain PWA session token: no client_id. Refused on purpose.
    assertEquals(callerFromClaims({ sub: USER, role: "authenticated" }), null);
    assertEquals(
      callerFromClaims({ sub: USER, role: "anon", client_id: "c1" }),
      null,
    );
    assertEquals(
      callerFromClaims({ sub: "", role: "authenticated", client_id: "c1" }),
      null,
    );
  },
);

Deno.test("a token the auth server accepts resolves to its user", async () => {
  const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
  const result = await verifyOAuthToken(token, "req-1", () =>
    Promise.resolve({ data: { user: { id: USER } }, error: null }),
  );
  assertEquals(result, { userId: USER, label: "oauth client c1" });
});

Deno.test(
  "a token whose claims disagree with the auth server is rejected",
  async () => {
    const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
    const result = await verifyOAuthToken(token, "req-2", () =>
      Promise.resolve({ data: { user: { id: "someone-else" } }, error: null }),
    );
    assertEquals(result, "rejected");
  },
);

Deno.test(
  "an auth server that says no is rejected; one we cannot reach is unavailable",
  async () => {
    const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
    assertEquals(
      await verifyOAuthToken(token, "req-3", () =>
        Promise.resolve({
          data: { user: null },
          error: { status: 401, name: "AuthApiError" },
        }),
      ),
      "rejected",
    );
    assertEquals(
      await verifyOAuthToken(token, "req-4", () =>
        Promise.resolve({
          data: { user: null },
          error: { status: 0, name: "AuthRetryableFetchError" },
        }),
      ),
      "unavailable",
    );
    assertEquals(
      await verifyOAuthToken(token, "req-5", () =>
        Promise.reject(new Error("socket hang up")),
      ),
      "unavailable",
    );
  },
);

Deno.test(
  "a session token without client_id is rejected before any network call",
  async () => {
    let called = false;
    const result = await verifyOAuthToken(
      jwt({ sub: USER, role: "authenticated" }),
      "req-6",
      () => {
        called = true;
        return Promise.resolve({ data: { user: { id: USER } }, error: null });
      },
    );
    assertEquals(result, "rejected");
    assertEquals(called, false);
  },
);

Deno.test("metadata names this resource and the project's auth server", () => {
  const doc = protectedResourceMetadata();
  assertEquals(doc.resource, "https://ref.supabase.co/functions/v1/mcp-server");
  assertEquals(doc.authorization_servers, ["https://ref.supabase.co/auth/v1"]);
  assertEquals(doc.bearer_methods_supported, ["header"]);
  assertEquals(
    resourceMetadataUrl(),
    "https://ref.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource",
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd supabase/functions/mcp-server && deno test --allow-env --allow-net lib/oauth.test.ts`
Expected: FAIL, `Module not found "file:///…/lib/oauth.ts"`.

- [ ] **Step 3: Implement `lib/oauth.ts`**

```ts
// OAuth access tokens from Supabase Auth's OAuth 2.1 server.
//
// This function is a RESOURCE server. Supabase Auth is the authorization
// server: it serves discovery, dynamic client registration, the token
// endpoint, and redirects the lifter to the PWA's consent page. All this file
// does is (1) tell a client where that authorization server is, and (2) turn a
// token it issued into the same Caller the mcp_tokens path produces, so every
// tool downstream is unchanged.
//
// Only a token carrying `client_id` is accepted. A plain PWA session JWT has
// none, and this server runs as the service role with RLS bypassed, so a
// session token lifted from a browser must not double as an MCP credential.
//
// Verification is `auth.getUser(token)`: one round trip, server-side, so a
// revoked grant stops working when Supabase says it does (docs/decisions.md,
// 2026-09-13). Nothing here is cached at module scope except configuration.

import { createClient } from "@supabase/supabase-js";
import type { Caller } from "./auth.ts";
import { log } from "./log.ts";

export type GetUser = (token: string) => Promise<{
  data: { user: { id: string } | null };
  error: { status?: number; name?: string } | null;
}>;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** stl_ tokens are base64url with no dots and coach tokens are two UUIDs, so a
 *  three-segment dotted token is unambiguous. */
export function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE.test(token);
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded =
      part.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (part.length % 4)) % 4);
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
      ),
    );
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function callerFromClaims(
  claims: Record<string, unknown>,
): Caller | null {
  const { sub, role, client_id } = claims;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (role !== "authenticated") return null;
  if (typeof client_id !== "string" || client_id.length === 0) return null;
  return { userId: sub, label: `oauth client ${client_id}` };
}

function supabaseUrl(): string {
  return (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
}

export function resourceUrl(): string {
  return `${supabaseUrl()}/functions/v1/mcp-server`;
}

export function resourceMetadataUrl(): string {
  return `${resourceUrl()}/.well-known/oauth-protected-resource`;
}

/** RFC 9728. Served unauthenticated; says nothing about users. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceUrl(),
    authorization_servers: [`${supabaseUrl()}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_name: "Strength Log",
  };
}

const defaultGetUser: GetUser = async (token) => {
  // Per call, never cached: the client carries no identity of its own, but the
  // rule in CLAUDE.md is simpler to keep than to argue exceptions to.
  const client = createClient(
    supabaseUrl(),
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await client.auth.getUser(token);
  return {
    data: { user: data.user ? { id: data.user.id } : null },
    error: error ? { status: error.status, name: error.name } : null,
  };
};

export async function verifyOAuthToken(
  token: string,
  requestId: string,
  getUser: GetUser = defaultGetUser,
): Promise<Caller | "rejected" | "unavailable"> {
  const claims = decodeJwtPayload(token);
  const caller = claims ? callerFromClaims(claims) : null;
  if (!caller) {
    log("warn", "oauth_rejected", { request_id: requestId, reason: "claims" });
    return "rejected";
  }
  try {
    const { data, error } = await getUser(token);
    if (error) {
      const unreachable =
        error.name === "AuthRetryableFetchError" ||
        error.status === undefined ||
        error.status === 0 ||
        error.status >= 500;
      log(
        unreachable ? "error" : "warn",
        unreachable ? "oauth_unavailable" : "oauth_rejected",
        {
          request_id: requestId,
          status: error.status,
        },
      );
      return unreachable ? "unavailable" : "rejected";
    }
    // The server vouched for the token; the claims must describe the same user.
    if (!data.user || data.user.id !== caller.userId) {
      log("warn", "oauth_rejected", {
        request_id: requestId,
        reason: "subject",
      });
      return "rejected";
    }
    return caller;
  } catch (err) {
    log("error", "oauth_unavailable", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `deno test --allow-env --allow-net lib/oauth.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing protocol tests**

Append to `supabase/functions/mcp-server/lib/protocol.test.ts`:

```ts
Deno.test(
  "protected-resource metadata is served without credentials",
  async () => {
    const res = await handleRequest(
      new Request(`${URL_}/.well-known/oauth-protected-resource`, {
        method: "GET",
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    const doc = await res.json();
    assertStringIncludes(doc.resource, "/functions/v1/mcp-server");
    assertStringIncludes(doc.authorization_servers[0], "/auth/v1");
  },
);

Deno.test(
  "every 401 points the client at the metadata, so it can start sign-in",
  async () => {
    const res = await handleRequest(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(INITIALIZE),
      }),
    );
    assertEquals(res.status, 401);
    assertStringIncludes(
      res.headers.get("www-authenticate") ?? "",
      'resource_metadata="http://127.0.0.1:1/functions/v1/mcp-server/.well-known/oauth-protected-resource"',
    );
    await res.body?.cancel();
  },
);

Deno.test(
  "an OAuth token the auth server cannot be asked about is 503, never 401",
  async () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const token = `${enc({ alg: "ES256" })}.${enc({
      sub: USER,
      role: "authenticated",
      client_id: "c1",
    })}.sig`;
    const res = await handleRequest(
      rpc(INITIALIZE, { authorization: `Bearer ${token}` }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
  },
);

Deno.test(
  "a session JWT with no client_id is 401 without contacting anyone",
  async () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const token = `${enc({ alg: "ES256" })}.${enc({ sub: USER, role: "authenticated" })}.sig`;
    const res = await handleRequest(
      rpc(INITIALIZE, { authorization: `Bearer ${token}` }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
);
```

Also add near the top, after the existing `Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", …)` line:

```ts
Deno.env.set("SUPABASE_ANON_KEY", "anon-not-used-here");
```

- [ ] **Step 6: Run to verify they fail**

Run: `deno test --allow-env --allow-net lib/protocol.test.ts`
Expected: three FAIL. The metadata test gets 401. The `resource_metadata` test fails on the header. The session-JWT test gets 503 instead of 401, because today the JWT goes to the `mcp_tokens` lookup, which cannot reach the closed port. The OAuth-503 test already passes for that same reason; it guards the new path after Step 7.

- [ ] **Step 7: Wire `auth.ts`**

In `lib/auth.ts`, add the import:

```ts
import {
  looksLikeJwt,
  resourceMetadataUrl,
  verifyOAuthToken,
} from "./oauth.ts";
```

Replace `unauthorized` with:

```ts
/** 401 that tells a client HOW to authenticate, per RFC 9110 and RFC 9728.
 *  `resource_metadata` is how ChatGPT and claude.ai find the sign-in flow; a
 *  client holding a static token never sees this unless its token is bad. */
function unauthorized(detail: string): Response {
  return new Response(JSON.stringify({ error: "Unauthorized", detail }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="strength-tracker", resource_metadata="${resourceMetadataUrl()}"`,
    },
  });
}
```

In `resolveCaller`, directly after the legacy-secret block and before `let client;`, add:

```ts
// Supabase OAuth access token (ChatGPT, claude.ai, any client that signed in).
// Checked after the legacy secret and before the mcp_tokens lookup: a JWT is
// never in mcp_tokens, so looking it up would only spend a round trip.
if (looksLikeJwt(token)) {
  const result = await verifyOAuthToken(token, requestId);
  if (result === "rejected") {
    return unauthorized("Sign in again, or use an MCP token.");
  }
  if (result === "unavailable") {
    return new Response(
      JSON.stringify({
        error: "Could not verify credentials",
        request_id: requestId,
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return result;
}
```

Update the file's header comment: after the paragraph ending `Tokens are minted by scripts/issue-mcp-token.mjs.`, add:

```ts
//
// OAUTH: clients that sign in (ChatGPT, claude.ai) send a Supabase OAuth access
// token instead. lib/oauth.ts verifies it and yields the same Caller, so nothing
// past this file can tell the two apart. See docs/decisions.md 2026-09-13.
```

- [ ] **Step 8: Wire `handler.ts`**

Add to the imports:

```ts
import { protectedResourceMetadata } from "./oauth.ts";
```

Directly after the `/health` block and before `// Auth before anything else.`, add:

```ts
// RFC 9728 discovery, before auth for the same reason as /health: a client
// with no credential has to be able to learn how to get one.
if (
  req.method === "GET" &&
  url.pathname.endsWith("/.well-known/oauth-protected-resource")
) {
  return json(200, protectedResourceMetadata());
}
```

Check that `json()` adds CORS headers (it is used by `/health`); if it does not, wrap with `withCors(json(...))`.

- [ ] **Step 9: Run the whole suite and type check**

Run: `deno check index.ts && deno test --allow-env --allow-net`
Expected: all tests PASS, including the pre-existing `no token is 401 and says how to authenticate` (it checks the header still includes `Bearer`).

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/mcp-server/lib/oauth.ts supabase/functions/mcp-server/lib/oauth.test.ts supabase/functions/mcp-server/lib/auth.ts supabase/functions/mcp-server/lib/handler.ts supabase/functions/mcp-server/lib/protocol.test.ts
git commit -m "Accept Supabase OAuth access tokens in the MCP server and advertise discovery"
```

---

### Task 3: Consent page in the PWA

**Files:**

- Create: `pwa/src/lib/oauthConsent.ts`
- Create: `pwa/src/lib/oauthConsent.test.ts`
- Create: `pwa/src/screens/OAuthConsent.tsx`
- Create: `pwa/src/screens/OAuthConsent.test.tsx`
- Modify: `pwa/src/App.tsx` (inside `App()`, after the `if (!session)` block)
- Modify: `pwa/src/styles.css` (components layer, next to `.train-home` rules)

**Interfaces:**

- Consumes: `supabase` from `pwa/src/lib/supabase.ts`; `reportError` from `pwa/src/lib/errors.ts`.
- Produces:
  - `isConsentPath(pathname: string, base: string): boolean`
  - `authorizationIdFrom(search: string): string | null`
  - `redirectHost(uri: string): string | null`
  - `OAuthConsent({ email }: { email: string | null }): JSX.Element`

- [ ] **Step 1: Write the failing helper tests**

`pwa/src/lib/oauthConsent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  authorizationIdFrom,
  isConsentPath,
  redirectHost,
} from "./oauthConsent";

describe("oauthConsent helpers", () => {
  it("recognises the consent path under the Pages base and at root", () => {
    expect(
      isConsentPath("/strength-tracker/oauth/consent", "/strength-tracker/"),
    ).toBe(true);
    expect(
      isConsentPath("/strength-tracker/oauth/consent/", "/strength-tracker/"),
    ).toBe(true);
    expect(isConsentPath("/oauth/consent", "/")).toBe(true);
    expect(isConsentPath("/strength-tracker/", "/strength-tracker/")).toBe(
      false,
    );
    expect(
      isConsentPath("/strength-tracker/program", "/strength-tracker/"),
    ).toBe(false);
  });

  it("reads the authorization id and refuses anything that is not a plain id", () => {
    expect(authorizationIdFrom("?authorization_id=abc-123")).toBe("abc-123");
    expect(authorizationIdFrom("")).toBeNull();
    expect(authorizationIdFrom("?authorization_id=")).toBeNull();
    expect(authorizationIdFrom("?authorization_id=a%2Fb")).toBeNull();
  });

  it("shows only the host of where the lifter will be sent", () => {
    expect(
      redirectHost("https://chatgpt.com/connector_platform_oauth_redirect"),
    ).toBe("chatgpt.com");
    expect(redirectHost("http://127.0.0.1:8976/callback")).toBe("127.0.0.1");
    expect(redirectHost("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd pwa && npm test -- --run src/lib/oauthConsent.test.ts`
Expected: FAIL, cannot resolve `./oauthConsent`.

- [ ] **Step 3: Implement the helpers**

`pwa/src/lib/oauthConsent.ts`:

```ts
// The consent step of MCP sign-in. Supabase Auth redirects a lifter here with
// `?authorization_id=…` when ChatGPT or claude.ai asks for access; this page
// shows who is asking and where they will be sent, and approves or denies.

const CONSENT_SUFFIX = "oauth/consent";

export function isConsentPath(pathname: string, base: string): boolean {
  const root = base.endsWith("/") ? base : `${base}/`;
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === `${root}${CONSENT_SUFFIX}`;
}

/** Authorization ids are opaque tokens; anything with a separator in it did
 *  not come from Supabase and is not worth sending back to it. */
export function authorizationIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get("authorization_id");
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** The part a person can check at a glance. A full redirect URI is noise; the
 *  host is what tells "chatgpt.com" apart from a lookalike. */
export function redirectHost(uri: string): string | null {
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the helper tests**

Run: `npm test -- --run src/lib/oauthConsent.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing screen tests**

`pwa/src/screens/OAuthConsent.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
  signOut: vi.fn(() => Promise.resolve({ error: null })),
  assign: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      signOut: h.signOut,
      oauth: {
        getAuthorizationDetails: h.getAuthorizationDetails,
        approveAuthorization: h.approveAuthorization,
        denyAuthorization: h.denyAuthorization,
      },
    },
  },
  supabaseConfigured: true,
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { OAuthConsent } from "./OAuthConsent";

const DETAILS = {
  authorization_id: "auth-1",
  redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
  client: {
    id: "c1",
    name: "ChatGPT",
    uri: "https://chatgpt.com",
    logo_uri: "",
  },
  user: { id: "u1", email: "val@example.com" },
  scope: "openid email",
};

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    "/oauth/consent?authorization_id=auth-1",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      assign: h.assign,
      search: "?authorization_id=auth-1",
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OAuthConsent", () => {
  it("names the client, the destination host and the account before asking", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    render(<OAuthConsent email="val@example.com" />);
    expect(
      await screen.findByText("ChatGPT wants to use your Strength Log"),
    ).toBeTruthy();
    expect(screen.getByText(/chatgpt\.com/)).toBeTruthy();
    expect(screen.getByText(/val@example\.com/)).toBeTruthy();
    expect(screen.getByText(/never change a logged set/i)).toBeTruthy();
  });

  it("approves and follows the redirect Supabase returns", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    h.approveAuthorization.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?code=x&state=y" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith(
        "https://chatgpt.com/cb?code=x&state=y",
      ),
    );
    expect(h.approveAuthorization).toHaveBeenCalledWith("auth-1", {
      skipBrowserRedirect: true,
    });
  });

  it("denies and still returns the lifter to the client", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    h.denyAuthorization.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?error=access_denied" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith(
        "https://chatgpt.com/cb?error=access_denied",
      ),
    );
  });

  it("skips the question when consent was already given", async () => {
    h.getAuthorizationDetails.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?code=z" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith("https://chatgpt.com/cb?code=z"),
    );
  });

  it("says the request expired instead of showing a broken page", async () => {
    h.getAuthorizationDetails.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    render(<OAuthConsent email="val@example.com" />);
    expect(
      await screen.findByText(/this sign-in request has expired/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- --run src/screens/OAuthConsent.test.tsx`
Expected: FAIL, cannot resolve `./OAuthConsent`.

- [ ] **Step 7: Implement the screen**

`pwa/src/screens/OAuthConsent.tsx`:

```tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { reportError } from "../lib/errors";
import { authorizationIdFrom, redirectHost } from "../lib/oauthConsent";

type Details = {
  authorization_id: string;
  redirect_uri: string;
  client: { name: string };
};

type State =
  | { kind: "loading" }
  | { kind: "ask"; details: Details }
  | { kind: "working" }
  | { kind: "expired" };

/**
 * Where Supabase Auth sends a lifter when an MCP client (ChatGPT, claude.ai)
 * asks for access. Rendered by App in place of the shell, after sign-in, so a
 * lifter who arrives signed out meets the normal Login screen first and lands
 * back here with the same URL.
 *
 * The page names the client AND the host it will redirect to, because dynamic
 * client registration lets anyone register any name: the host is the part a
 * lookalike cannot fake.
 */
export function OAuthConsent({ email }: { email: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const authorizationId = authorizationIdFrom(window.location.search);

  useEffect(() => {
    if (!authorizationId) {
      setState({ kind: "expired" });
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } =
        await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (cancelled) return;
      if (error || !data) {
        if (error)
          reportError(error, { where: "oauth.getAuthorizationDetails" });
        setState({ kind: "expired" });
        return;
      }
      if ("redirect_url" in data) {
        window.location.assign(data.redirect_url);
        return;
      }
      setState({ kind: "ask", details: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizationId]);

  const decide = async (approve: boolean) => {
    if (!authorizationId) return;
    setState({ kind: "working" });
    const call = approve
      ? supabase.auth.oauth.approveAuthorization
      : supabase.auth.oauth.denyAuthorization;
    const { data, error } = await call.call(
      supabase.auth.oauth,
      authorizationId,
      {
        skipBrowserRedirect: true,
      },
    );
    if (error || !data) {
      if (error)
        reportError(error, { where: approve ? "oauth.approve" : "oauth.deny" });
      setState({ kind: "expired" });
      return;
    }
    window.location.assign(data.redirect_url);
  };

  if (state.kind === "expired") {
    return (
      <main className="oauth-consent">
        <h1 className="oauth-consent-title">
          This sign-in request has expired
        </h1>
        <p className="microcopy">
          Go back to the app that sent you here and connect again.
        </p>
      </main>
    );
  }

  if (state.kind !== "ask") {
    return (
      <main className="oauth-consent">
        <p className="microcopy">Checking the request…</p>
      </main>
    );
  }

  const { details } = state;
  const host = redirectHost(details.redirect_uri);

  return (
    <main className="oauth-consent">
      <div className="field-label">CONNECT AN APP</div>
      <h1 className="oauth-consent-title">
        {details.client.name} wants to use your Strength Log
      </h1>
      <p className="oauth-consent-body">
        It will read your training history and can write plans, goals, training
        maxes and notes. It can never change a logged set.
      </p>
      <p className="microcopy">
        Signed in as {email ?? "this account"}. After you choose, you go back to{" "}
        <strong>{host ?? "the app"}</strong>.
      </p>
      <div className="oauth-consent-actions">
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => void decide(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => void decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => void supabase.auth.signOut({ scope: "local" })}
        >
          Not you? Sign out
        </button>
      </div>
    </main>
  );
}
```

If `reportError`'s signature in `pwa/src/lib/errors.ts` differs from `(error, context)`, match the file's actual signature; do not add a new one.

- [ ] **Step 8: Add the styles**

In `pwa/src/styles.css`, in the components layer after the `.train-home` block:

```css
/* MCP sign-in consent. Stands alone (no top bar, no nav): it is reached from
   * another app's sign-in flow, usually in a desktop browser, and has exactly
   * one decision on it. */
.oauth-consent {
  max-width: 32rem;
  margin: 0 auto;
  padding: var(--s-8) var(--s-5);
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
}

.oauth-consent-title {
  margin: 0;
  font-size: var(--fs-xl);
  line-height: 1.15;
}

.oauth-consent-body {
  margin: 0;
}

.oauth-consent-actions {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  margin-top: var(--s-5);
}
```

Before committing, confirm `--fs-xl`, `--s-3`, `--s-5`, `--s-8` exist in the tokens layer (`grep -n "\-\-fs-xl\|\-\-s-3:" pwa/src/styles.css`); substitute the nearest existing token if one does not.

- [ ] **Step 9: Mount it in `App.tsx`**

Add imports:

```tsx
import { OAuthConsent } from "./screens/OAuthConsent";
import { isConsentPath } from "./lib/oauthConsent";
```

Directly after the `if (!session) { … }` block in `App()`:

```tsx
// MCP sign-in consent renders INSTEAD of the shell: no reconciliation, no
// outbox flush, no nav. Signed-out visitors met Login above with the URL
// intact, so they arrive here after entering their code.
if (isConsentPath(window.location.pathname, import.meta.env.BASE_URL)) {
  return (
    <>
      <Toasts />
      <OAuthConsent email={session.user.email ?? null} />
    </>
  );
}
```

- [ ] **Step 10: Run tests, types, build**

Run: `npm test -- --run && npm run typecheck && npm run build`
Expected: all PASS; build prints `dist/sw.js`.

- [ ] **Step 11: Verify in the browser**

Start the `pwa-demo-alt` preview (port 5210), navigate to `http://localhost:5210/oauth/consent?authorization_id=x`. The demo mock has no `auth.oauth`, so expect the "expired" state rendered standalone with no top bar or nav. Screenshot it at 390×844. Then confirm `http://localhost:5210/` still renders Train.

If the demo mock throws on `supabase.auth.oauth` being undefined, guard in `OAuthConsent`'s effect: `if (typeof supabase.auth.oauth?.getAuthorizationDetails !== "function") { setState({ kind: "expired" }); return; }` and add a test for it.

- [ ] **Step 12: Commit**

```bash
git add pwa/src/lib/oauthConsent.ts pwa/src/lib/oauthConsent.test.ts pwa/src/screens/OAuthConsent.tsx pwa/src/screens/OAuthConsent.test.tsx pwa/src/App.tsx pwa/src/styles.css
git commit -m "Add the MCP sign-in consent page"
```

- [ ] **Step 13: Finish the spike facts**

Push `main` (deploys Pages and the Task 2 function). Re-run `node scripts/oauth-spike.mjs --mcp`, sign in, Allow. Expected: claims print with `client_id`; `/auth/v1/user` 200; `MCP tools/list: 200 33 tools`. Update the bracketed values in the 2026-09-13 decisions entry and commit `docs/decisions.md`.

---

### Task 4: Connected apps in Settings

**Files:**

- Create: `pwa/src/components/ConnectedApps.tsx`
- Create: `pwa/src/components/ConnectedApps.test.tsx`
- Modify: `pwa/src/components/SettingsSheet.tsx` (after the TRAINING `settings-group` section)

**Interfaces:**

- Consumes: `supabase.auth.oauth.listGrants(): Promise<{ data: { client: { id: string; name: string }; scopes: string[]; granted_at: string }[] | null; error }>` and `supabase.auth.oauth.revokeGrant({ clientId }): Promise<{ error }>`.
- Produces: `ConnectedApps(): JSX.Element | null`.

- [ ] **Step 1: Write the failing tests**

`pwa/src/components/ConnectedApps.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ listGrants: vi.fn(), revokeGrant: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: { oauth: { listGrants: h.listGrants, revokeGrant: h.revokeGrant } },
  },
  supabaseConfigured: true,
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { ConnectedApps } from "./ConnectedApps";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const GRANT = {
  client: { id: "c1", name: "ChatGPT", uri: "", logo_uri: "" },
  scopes: ["openid"],
  granted_at: "2026-09-13T10:00:00Z",
};

describe("ConnectedApps", () => {
  it("lists each connected app with a disconnect action", async () => {
    h.listGrants.mockResolvedValue({ data: [GRANT], error: null });
    render(<ConnectedApps />);
    expect(await screen.findByText("ChatGPT")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Disconnect ChatGPT" }),
    ).toBeTruthy();
  });

  it("revokes by client id and removes the row", async () => {
    h.listGrants.mockResolvedValue({ data: [GRANT], error: null });
    h.revokeGrant.mockResolvedValue({ data: {}, error: null });
    render(<ConnectedApps />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect ChatGPT" }),
    );
    await vi.waitFor(() =>
      expect(h.revokeGrant).toHaveBeenCalledWith({ clientId: "c1" }),
    );
    await vi.waitFor(() => expect(screen.queryByText("ChatGPT")).toBeNull());
  });

  it("says none rather than rendering an empty list", async () => {
    h.listGrants.mockResolvedValue({ data: [], error: null });
    render(<ConnectedApps />);
    expect(await screen.findByText("NONE")).toBeTruthy();
  });

  it("says it could not load rather than claiming there are none", async () => {
    h.listGrants.mockResolvedValue({ data: null, error: { message: "boom" } });
    render(<ConnectedApps />);
    expect(await screen.findByText("COULDN’T LOAD")).toBeTruthy();
    expect(screen.queryByText("NONE")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --run src/components/ConnectedApps.test.tsx`
Expected: FAIL, cannot resolve `./ConnectedApps`.

- [ ] **Step 3: Implement**

`pwa/src/components/ConnectedApps.tsx`. Use the microcopy string that matches the revocation fact recorded in Task 1: if revocation was immediate use `REVOKE_COPY_IMMEDIATE`, otherwise `REVOKE_COPY_DELAYED`, and delete the other constant.

```tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { reportError } from "../lib/errors";

type Grant = { client: { id: string; name: string }; granted_at: string };
type Load =
  { kind: "loading" } | { kind: "failed" } | { kind: "ok"; grants: Grant[] };

const REVOKE_COPY_IMMEDIATE =
  "Apps you signed in to with this account, like ChatGPT or Claude. Disconnecting stops their access now.";
const REVOKE_COPY_DELAYED =
  "Apps you signed in to with this account, like ChatGPT or Claude. Disconnecting stops their access within the hour.";

/**
 * MCP clients this person approved on the consent page. Server data, like
 * training maxes, so it sits with TRAINING rather than the device settings.
 * Renders nothing where the OAuth API is absent (the demo mock, older tests)
 * rather than a row that can only fail.
 */
export function ConnectedApps() {
  const oauth = supabase.auth.oauth;
  const available = typeof oauth?.listGrants === "function";
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await oauth.listGrants();
      if (cancelled) return;
      if (error || !data) {
        if (error) reportError(error, { where: "oauth.listGrants" });
        setLoad({ kind: "failed" });
        return;
      }
      setLoad({ kind: "ok", grants: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [available, oauth]);

  if (!available) return null;

  const disconnect = async (clientId: string) => {
    const { error } = await oauth.revokeGrant({ clientId });
    if (error) {
      reportError(error, { where: "oauth.revokeGrant" });
      return;
    }
    setLoad((prev) =>
      prev.kind === "ok"
        ? {
            kind: "ok",
            grants: prev.grants.filter((g) => g.client.id !== clientId),
          }
        : prev,
    );
  };

  return (
    <section className="settings-group">
      <div className="field-label">CONNECTED APPS</div>
      {load.kind === "ok" && load.grants.length > 0 ? (
        load.grants.map((grant) => (
          <div key={grant.client.id} className="sheet-row">
            <span>{grant.client.name}</span>
            <button
              type="button"
              className="sheet-row-value sheet-row-btn"
              aria-label={`Disconnect ${grant.client.name}`}
              onClick={() => void disconnect(grant.client.id)}
            >
              DISCONNECT
            </button>
          </div>
        ))
      ) : (
        <div className="sheet-row">
          <span>Connected apps</span>
          <span className="sheet-row-value">
            {load.kind === "loading"
              ? "…"
              : load.kind === "failed"
                ? "COULDN’T LOAD"
                : "NONE"}
          </span>
        </div>
      )}
      <div className="microcopy">{REVOKE_COPY_IMMEDIATE}</div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --run src/components/ConnectedApps.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mount in Settings**

In `pwa/src/components/SettingsSheet.tsx`, import `import { ConnectedApps } from "./ConnectedApps";` and place `<ConnectedApps />` directly after the closing `</section>` of the TRAINING group.

- [ ] **Step 6: Full PWA checks**

Run: `npm test -- --run && npm run typecheck && npm run build`
Expected: all PASS. `SettingsSheet.test.tsx` mocks `supabase.auth` without `oauth`, so `ConnectedApps` must render nothing there; if that test fails, the `available` guard is wrong.

- [ ] **Step 7: Commit**

```bash
git add pwa/src/components/ConnectedApps.tsx pwa/src/components/ConnectedApps.test.tsx pwa/src/components/SettingsSheet.tsx
git commit -m "List and disconnect MCP apps from Settings"
```

---

### Task 5: Annotate every tool so clients can tell reads from overwrites

ChatGPT asks for confirmation on any tool that does not declare itself read-only, and the MCP spec defaults `destructiveHint` to true and `openWorldHint` to true. The App Directory also requires explicit annotations. 16 tools already declare `readOnlyHint: true`; none declare the other two.

**Files:**

- Modify: every file in `supabase/functions/mcp-server/tools/` that calls `server.registerTool` (22 files, 33 tools)
- Modify: `supabase/functions/mcp-server/lib/protocol.test.ts`

**Interfaces:**

- Produces: every tool in `tools/list` carries `annotations` with boolean `readOnlyHint`, `destructiveHint`, `openWorldHint`.

- [ ] **Step 1: Write the failing test**

Append to `lib/protocol.test.ts`:

```ts
// What each tool may do to data that already exists. destructive = it can
// delete or overwrite something the lifter or another account already has.
// Additive writes (a new unconfirmed program, a dated training max row that
// does not replace another date) are not destructive. Keep in step with the
// tool's own write; a wrong "false" here removes a confirmation prompt.
const EXPECTED_ANNOTATIONS: Record<
  string,
  { readOnly: boolean; destructive: boolean }
> = {
  search_exercises: { readOnly: true, destructive: false },
  resolve_exercises: { readOnly: true, destructive: false },
  get_lift_history: { readOnly: true, destructive: false },
  get_recent_sessions: { readOnly: true, destructive: false },
  get_checkins: { readOnly: true, destructive: false },
  get_goal_progress: { readOnly: true, destructive: false },
  get_volume: { readOnly: true, destructive: false },
  get_training_maxes: { readOnly: true, destructive: false },
  get_week_summary: { readOnly: true, destructive: false },
  get_memory: { readOnly: true, destructive: false },
  list_programs: { readOnly: true, destructive: false },
  get_program: { readOnly: true, destructive: false },
  get_exercise_notes: { readOnly: true, destructive: false },
  list_feedback: { readOnly: true, destructive: false },
  find_similar_days: { readOnly: true, destructive: false },
  get_training_plan: { readOnly: true, destructive: false },
  upsert_program: { readOnly: false, destructive: false },
  confirm_program: { readOnly: false, destructive: false },
  repeat_planned_workout: { readOnly: false, destructive: false },
  set_training_plan: { readOnly: false, destructive: false },
  confirm_training_plan: { readOnly: false, destructive: false },
  remember: { readOnly: false, destructive: false },
  submit_feedback: { readOnly: false, destructive: false },
  resolve_feedback: { readOnly: false, destructive: false },
  add_exercise: { readOnly: false, destructive: false },
  set_goal: { readOnly: false, destructive: true },
  set_training_max: { readOnly: false, destructive: true },
  set_exercise_note: { readOnly: false, destructive: true },
  update_planned_workout: { readOnly: false, destructive: true },
  update_exercise: { readOnly: false, destructive: true },
  forget: { readOnly: false, destructive: true },
  delete_program: { readOnly: false, destructive: true },
  delete_exercise: { readOnly: false, destructive: true },
};

Deno.test("every tool declares what it does to existing data", async () => {
  const res = await handleRequest(
    rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  );
  const { result } = await res.json();
  const names = result.tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, Object.keys(EXPECTED_ANNOTATIONS).sort());
  for (const tool of result.tools) {
    const expected = EXPECTED_ANNOTATIONS[tool.name];
    assertEquals(
      tool.annotations?.readOnlyHint,
      expected.readOnly,
      `${tool.name} readOnlyHint`,
    );
    assertEquals(
      tool.annotations?.destructiveHint,
      expected.destructive,
      `${tool.name} destructiveHint`,
    );
    // Every tool reads and writes this lifter's own log, never the open web.
    assertEquals(
      tool.annotations?.openWorldHint,
      false,
      `${tool.name} openWorldHint`,
    );
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd supabase/functions/mcp-server && deno test --allow-env --allow-net lib/protocol.test.ts`
Expected: FAIL on the first tool whose `destructiveHint` is undefined. If the name list itself fails, a tool name differs from the table; read the actual name from the failure and fix the TABLE only after confirming the tool's registered name in `tools/`.

- [ ] **Step 3: Before editing, check the three judgement calls against the code**

- `set_training_max` (`tools/set_training_max.ts` upsert): destructive only if the upsert conflict target can replace an existing row for the same exercise and date. If it cannot, set the table and tool to `destructive: false`.
- `set_exercise_note` (`tools/exercise_notes.ts`): destructive because it can delete (an empty note clears) and upserts over the previous note.
- `update_exercise`: destructive because it overwrites a SHARED library row (CLAUDE.md "Exercise library sources").

- [ ] **Step 4: Add annotations to each tool**

For each `server.registerTool(name, { …, annotations: … })`, set the object to exactly the table's values, for example in `tools/get_week_summary.ts`:

```ts
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
```

and in `tools/delete_program.ts`, which currently has no `annotations` key, add after `inputSchema`:

```ts
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
```

Repeat for all 33 tools. Also update the `get_checkins.test.ts` assertion only if it compares the whole annotations object (it reads `readOnlyHint` alone today, so it should need no change).

- [ ] **Step 5: Run the suite and type check**

Run: `deno check index.ts && deno test --allow-env --allow-net`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp-server/tools supabase/functions/mcp-server/lib/protocol.test.ts
git commit -m "Declare read-only, destructive and open-world hints on every MCP tool"
```

(`git add` of the `tools` directory is explicit-path; confirm `git status` shows only annotation changes in it before committing.)

---

### Task 6: Config, docs, and end-to-end connection

**Files:**

- Modify: `supabase/config.toml` (after the `[auth]` block's `additional_redirect_urls`)
- Modify: `docs/setup.md` (section 3, the connection instructions)
- Modify: `CLAUDE.md` (the "Identity:" hard rule)

- [ ] **Step 1: Mirror the settings in `config.toml`**

```toml
# MCP sign-in (docs/decisions.md 2026-09-13). The hosted project is configured
# in the dashboard; this mirrors it for `supabase start`. Dynamic registration
# is open by design: the gate is the lifter's sign-in plus Allow on
# /oauth/consent, which names the client and its redirect host.
[auth.oauth_server]
enabled = true
allow_dynamic_registration = true
authorization_url_path = "/oauth/consent"
```

Run: `supabase start` is not required; validate the file parses with `supabase --help >/dev/null && grep -n "oauth_server" supabase/config.toml`. If the CLI rejects an unknown key on `supabase db reset`, remove only that key and note it in the comment.

- [ ] **Step 2: Rewrite the connection docs**

In `docs/setup.md` section 3, add a new first subsection above "ChatGPT through a Secure MCP Tunnel":

```markdown
### Any client that supports sign-in (ChatGPT, claude.ai, Claude Desktop connectors)

Add the server URL and sign in with your Strength Log account. No token.

    https://<project-ref>.supabase.co/functions/v1/mcp-server

- **ChatGPT** (Plus, Pro, Business, Enterprise, Edu; web only): turn on
  Developer mode (the OpenAI developer-mode guide has the current menu path),
  then create an app with the URL
  above and authentication **OAuth**. ChatGPT opens a sign-in window: enter the
  email code, then **Allow**.
- **claude.ai / Claude Desktop**: Settings → Connectors → Add custom connector,
  paste the URL, Connect, sign in, **Allow**.
- Disconnect from the app's Settings → CONNECTED APPS.

The sign-in window is a normal browser page, not the installed app, so it asks
for an email code even on a phone where the app is already signed in.
Menu names in ChatGPT and Claude move; the OpenAI developer-mode guide and
Anthropic's connector docs are the current source.
```

Retitle the existing tunnel subsection to "ChatGPT through a Secure MCP Tunnel (fallback, superseded by sign-in)" and leave its content. Replace the "**What this is not.** There is no OAuth here…" paragraph with:

```markdown
**Tokens still work.** `scripts/issue-mcp-token.mjs` tokens are for clients
with a header field (Claude Desktop via mcp-remote, scripts). Sign-in is for
everything else.
```

- [ ] **Step 3: Update the identity rule in `CLAUDE.md`**

In the "Identity:" bullet, after `The token IS the identity: \`mcp_tokens\` maps its SHA-256 to a user, and every tool must filter and stamp \`db.ownerId\` itself.` insert:

```markdown
A client that signed in instead sends a Supabase OAuth access token;
`lib/oauth.ts` accepts it ONLY when it carries `client_id` (a plain session
JWT is refused, because this server bypasses RLS) and verifies it with
`auth.getUser`, yielding the same `Caller`. Dynamic client registration is
open; the gate is the lifter's sign-in plus Allow on `/oauth/consent`.
```

- [ ] **Step 4: Commit and push**

```bash
git add supabase/config.toml docs/setup.md CLAUDE.md
git commit -m "Document MCP sign-in as the default connection path"
git push origin main
```

Then: `gh run list --branch main --limit 2` and `gh run watch <deploy-run-id> --exit-status`. Expected: deploy succeeds, log contains the mcp-server deploy step.

- [ ] **Step 5: End-to-end, claude.ai (Colt, with the implementer watching logs)**

Colt: claude.ai → Settings → Connectors → Add custom connector → URL `https://idjjdmtgchcpwqmtkoza.supabase.co/functions/v1/mcp-server` → Connect → email code → Allow. Ask Claude: "What was my training last week?"

Implementer: `supabase functions logs mcp-server` (or the Supabase MCP `query_logs`). Expected: `request` lines with `caller: "oauth client <id>"`, `outcome: "ok"`, `tool: "get_week_summary"`.

- [ ] **Step 6: End-to-end, ChatGPT (Colt, Plus or above, web)**

Colt: enable Developer mode, create the app with the same URL and OAuth, sign in, Allow, scan tools (33). Ask "What was my training last week?" (no confirmation prompt, it is read-only), then "Set a goal: squat 160 kg by December" (ChatGPT shows a confirmation, because `set_goal` is destructive).

Expected in logs: two `oauth client` callers now (Claude and ChatGPT), both `ok`.

- [ ] **Step 7: Revocation check**

Colt: PWA Settings → CONNECTED APPS → Disconnect ChatGPT. Ask ChatGPT another question. Expected: 401 (`oauth_rejected` in logs) immediately, or within the lifetime recorded in Task 1 if revocation was delayed; ChatGPT then offers to reconnect. Confirm the microcopy chosen in Task 4 matches what happened; fix the string if not.

- [ ] **Step 8: Regression check on existing credentials**

Run the existing Claude connector read (`mcp__strength-log__get_week_summary` from a Claude Code session). Expected: works, logs show the `stl_` token's label. Start a coach turn in the PWA. Expected: answers normally (its per-turn token path is unchanged).

---

## Self-review notes

- Spec coverage: discovery (Task 2), token acceptance with client_id rule and 503/401 split (Task 2), consent page (Task 3), revoke (Task 4), confirmation UX and directory prerequisite (Task 5), config and docs and real clients (Task 6), the open Supabase bug (Task 1 gate). App Directory submission is deliberately out of scope.
- The consent-page fact 1 can be observed before Task 3; facts 2–4 need a working consent page, which is why Task 3 ends by completing the spike rather than Task 1 trying to.
