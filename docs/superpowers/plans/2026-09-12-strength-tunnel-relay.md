# Strength Tracker tunnel relay implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing Strength Tracker MCP through an OpenAI Secure MCP Tunnel without exposing the per-user bearer token to ChatGPT or the tunnel-client profile.

**Architecture:** A Node relay accepts only loopback `POST /mcp` requests and forwards them to the configured HTTPS Supabase endpoint with a Keychain-sourced bearer. A supervisor owns the relay and `tunnel-client`, restarting them together after failure. A LaunchAgent starts the supervisor at login.

**Tech Stack:** Node.js built-in `http`, `child_process`, and `node:test`; macOS Keychain and LaunchAgent; OpenAI `tunnel-client`; Supabase Edge Function MCP endpoint.

**Spec:** `docs/superpowers/specs/2026-09-12-strength-tunnel-relay-design.md`

## Global Constraints

- Bind the relay only to `127.0.0.1`; do not create a public listener.
- Accept only `POST /mcp` and `OPTIONS /mcp`.
- Require HTTPS for the configured upstream URL and disable redirects.
- Replace caller authorization headers with `Authorization: Bearer ${STRENGTH_MCP_TOKEN}`.
- Never write the Strength Tracker bearer or OpenAI runtime key to a profile, plist, file, or log.
- Keep the existing Supabase Edge Function and MCP tool surface unchanged.
- Do not create an OpenAI tunnel, runtime API key, Keychain entry, or LaunchAgent without interactive confirmation.

---

### Task 1: Loopback relay

**Files:**
- Create: `scripts/strength-mcp-relay.mjs`
- Create: `scripts/strength-mcp-relay.test.mjs`
- Modify: `scripts/package.json`

**Interfaces:**
- Produces `validateRelayConfig({ upstreamUrl, token })`, returning a normalized HTTPS URL or throwing.
- Produces `createRelayServer({ upstreamUrl, token, logger, fetchImpl })`, returning a Node HTTP server. `fetchImpl` defaults to global `fetch` and exists only to make HTTPS-only forwarding testable without weakening the production URL rule.
- Consumes `STRENGTH_MCP_URL`, `STRENGTH_MCP_TOKEN`, and optional `STRENGTH_MCP_RELAY_PORT` when run as a script.

- [ ] **Step 1: Write the failing relay test**

```js
test("replaces caller credentials with the configured bearer", async () => {
  const upstream = { headers: null };
  const relay = await startRelay({
    upstreamUrl: "https://strength.example.test/mcp", token: "stored-token",
    fetchImpl: async (_url, init) => {
      upstream.headers = Object.fromEntries(init.headers);
      return new Response('{"jsonrpc":"2.0","result":{}}', { headers: { "content-type": "application/json" } });
    },
  });
  const response = await fetch(relay.url, {
    method: "POST",
    headers: { authorization: "Bearer attacker", "x-api-key": "attacker" },
    body: '{"jsonrpc":"2.0","method":"tools/list"}',
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.headers.authorization, "Bearer stored-token");
  assert.equal(upstream.headers["x-api-key"], undefined);
});

test("rejects non-MCP routes, unsupported methods, HTTP upstreams, and redirects", async () => {
  assert.throws(() => validateRelayConfig({ upstreamUrl: "http://127.0.0.1/mcp", token: "x" }));
  const relay = await startRelay();
  assert.equal((await fetch(`${relay.url}/wrong`, { method: "POST" })).status, 404);
  assert.equal((await fetch(relay.url, { method: "GET" })).status, 405);
  assert.equal((await fetch(relay.url, { method: "POST", body: "{}" })).status, 502);
});
```

- [ ] **Step 2: Run the relay test to verify it fails**

Run: `node --test scripts/strength-mcp-relay.test.mjs`

Expected: FAIL because `scripts/strength-mcp-relay.mjs` does not exist.

- [ ] **Step 3: Implement the smallest relay**

Implement `validateRelayConfig` to parse the configured URL, require `https:`, reject URL credentials and fragments, and normalize `/mcp`. Implement `createRelayServer` with `http.createServer`; return `204` with CORS headers for `OPTIONS /mcp`, reject every other route and method, and proxy the raw body using `fetch` with `redirect: "error"`. Copy only `content-type`, `cache-control`, and `mcp-session-id` from the response. Remove caller `authorization` and `x-api-key` before adding the configured bearer. Log only lifecycle metadata.

- [ ] **Step 4: Run the relay test to verify it passes**

Run: `node --test scripts/strength-mcp-relay.test.mjs`

Expected: PASS, including header replacement, route/method rejection, response preservation, and fail-closed cases.

- [ ] **Step 5: Add and verify the package command**

Add `"test:tunnel-relay": "node --test strength-mcp-relay.test.mjs"` to `scripts/package.json`.

Run: `npm run test:tunnel-relay --prefix scripts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/strength-mcp-relay.mjs scripts/strength-mcp-relay.test.mjs scripts/package.json
git commit -m "Add loopback MCP tunnel relay"
```

### Task 2: Keychain-backed supervisor

**Files:**
- Create: `scripts/strength-tunnel-supervisor.mjs`
- Create: `scripts/strength-tunnel-supervisor.test.mjs`
- Modify: `scripts/package.json`

**Interfaces:**
- Produces `readKeychainSecret({ service, account, execFile, logger })`, returning a trimmed secret without logging it.
- Produces `supervise({ spawn, relayCommand, tunnelCommand, env, delay, logger })`, which starts relay before tunnel and restarts the pair after either child exits.
- Consumes `STRENGTH_MCP_KEYCHAIN_SERVICE`, `STRENGTH_MCP_KEYCHAIN_ACCOUNT`, `OPENAI_TUNNEL_KEYCHAIN_SERVICE`, `OPENAI_TUNNEL_KEYCHAIN_ACCOUNT`, `STRENGTH_MCP_URL`, `STRENGTH_MCP_RELAY_PORT`, `TUNNEL_CLIENT_BIN`, and `TUNNEL_PROFILE`.

- [ ] **Step 1: Write the failing supervisor test**

```js
test("reads and trims the Keychain token without logging it", async () => {
  const logs = [];
  const token = await readKeychainSecret({
    service: "Strength Tracker MCP", account: "colt", logger: (line) => logs.push(line),
    execFile: async () => ({ stdout: "stl_secret\\n" }),
  });
  assert.equal(token, "stl_secret");
  assert.equal(logs.join("\\n").includes("stl_secret"), false);
});

test("starts the relay before the tunnel and stops both when one exits", async () => {
  const events = await runWithFakeChildren();
  assert.deepEqual(events.slice(0, 2), ["relay:start", "tunnel:start"]);
  assert.deepEqual(events.filter((event) => event.endsWith(":stop")), ["tunnel:stop", "relay:stop"]);
});
```

- [ ] **Step 2: Run the supervisor test to verify it fails**

Run: `node --test scripts/strength-tunnel-supervisor.test.mjs`

Expected: FAIL because `scripts/strength-tunnel-supervisor.mjs` does not exist.

- [ ] **Step 3: Implement the supervisor**

Use `execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"])` to fetch each Keychain item. Spawn the relay with an explicit small environment containing only the upstream URL, Strength Tracker bearer, and port. Pass the OpenAI runtime key only as `CONTROL_PLANE_API_KEY` to `tunnel-client`. Start `tunnel-client run --profile <name>` only after relay readiness succeeds. Forward SIGINT and SIGTERM to both children. On unexpected exit, stop both, wait 1, 2, 4, 8, then at most 30 seconds, and restart. Keep all lifecycle logs secret-free.

- [ ] **Step 4: Run the supervisor test to verify it passes**

Run: `node --test scripts/strength-tunnel-supervisor.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add and verify the package command**

Add `"test:tunnel-supervisor": "node --test strength-tunnel-supervisor.test.mjs"` to `scripts/package.json`.

Run: `npm run test:tunnel-supervisor --prefix scripts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/strength-tunnel-supervisor.mjs scripts/strength-tunnel-supervisor.test.mjs scripts/package.json
git commit -m "Add Keychain-backed tunnel supervisor"
```

### Task 3: User-installable tunnel configuration

**Files:**
- Create: `scripts/strength-tunnel-client.yaml.example`
- Create: `scripts/com.strength-tracker.mcp-tunnel.plist.template`
- Create: `scripts/strength-tunnel-config.test.mjs`
- Modify: `docs/setup.md`
- Modify: `docs/security.md`
- Modify: `docs/decisions.md`

**Interfaces:**
- The YAML example contains a tunnel ID placeholder and `env:CONTROL_PLANE_API_KEY`, but no Strength Tracker bearer.
- The plist template calls `node <repo>/scripts/strength-tunnel-supervisor.mjs` and carries only non-secret configuration.
- Setup instructions create and remove the Keychain item, profile, and LaunchAgent reproducibly.

- [ ] **Step 1: Write the failing configuration safety test**

```js
test("tracked tunnel configuration cannot contain a Strength Tracker bearer", async () => {
  for (const path of ["scripts/strength-tunnel-client.yaml.example", "scripts/com.strength-tracker.mcp-tunnel.plist.template"]) {
    const text = await readFile(path, "utf8");
    assert.equal(text.includes("stl_"), false, `${path} contains a bearer-looking value`);
    assert.equal(text.includes("STRENGTH_MCP_TOKEN"), false, `${path} accepts a plaintext token`);
  }
});
```

- [ ] **Step 2: Run the configuration test to verify it fails**

Run: `node --test scripts/strength-tunnel-config.test.mjs`

Expected: FAIL because the example profile and plist template do not exist.

- [ ] **Step 3: Add configuration and documentation**

Create a profile with `mcp.server_urls[0].url` set to `http://127.0.0.1:8786/mcp`, a control-plane API key reference, and a `tunnel_...` placeholder. Create a plist template using `RunAtLoad`, `KeepAlive`, an explicit Node path placeholder, and log paths under `~/Library/Logs/StrengthTracker`. Document exact Keychain, profile, doctor, LaunchAgent install/removal, health-check, token-revocation, and Keychain-removal commands.

- [ ] **Step 4: Run the configuration test to verify it passes**

Run: `node --test scripts/strength-tunnel-config.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full relevant verification**

Run: `npm run test:tunnel-relay --prefix scripts`

Run: `npm run test:tunnel-supervisor --prefix scripts`

Run: `node --test scripts/strength-tunnel-config.test.mjs`

Run from `supabase/functions/mcp-server`: `deno test --allow-env --allow-net`

Expected: all Node tunnel tests and all existing Deno MCP tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/strength-tunnel-client.yaml.example scripts/com.strength-tracker.mcp-tunnel.plist.template scripts/strength-tunnel-config.test.mjs docs/setup.md docs/security.md docs/decisions.md
git commit -m "Document private ChatGPT tunnel setup"
```
