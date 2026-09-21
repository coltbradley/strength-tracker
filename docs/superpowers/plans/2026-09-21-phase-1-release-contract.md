# Phase 1 Slice 2: Release Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A missing PWA env cannot publish, a skipped backend cannot publish a client that needed it, a deployed release has a smoke receipt, and CI remaining red due to billing does not block deploy.

**Architecture:** A Node env checker runs in the Pages job before `vite build`. The production client also refuses placeholder Supabase env at module init. The supabase job **fails** (not skip-success) when `supabase/` changed and secrets are missing. After Pages publish, curl the PWA and (when the project ref is set) MCP `/health`. `/health` pings env + `mcp_tokens` and 503s when either fails. No `workflow_run`, no required CI status check.

**Tech Stack:** Node `node:test` for scripts and the deploy.yml contract; Deno `jsr:@std/assert` for MCP health; Vitest for the PWA env throw; GitHub Actions YAML already in `.github/workflows/deploy.yml`.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-1-release-contract-design.md`. Evidence: `docs/audits/2026-09-19-system-audit.md` A-24, A-25, A-134–A-138. A-26 is already `fixed with test` in Phase 0; do not touch it.

## Global Constraints

- GitHub Actions **CI is billed-out and fails automatically**. Deploy still runs. Do not add `workflow_run`, `needs: ci`, required status checks, or any job that treats a missing CI run as a failed release. A later `require_ci` dispatch input is out of scope.
- When `needs.changes.outputs.supabase == 'true'` and the three settings are not all set, the supabase job **fails**. When supabase paths did not change, that job stays skipped and Pages may still publish.
- `load_kg`, RLS, MCP writes to `sets`/`sessions`, and Slice 1 admission work are out of scope. This PR is deploy + health + env only.
- Never print, commit, or log a real secret, anon key, or service-role value. Checker messages name the **variable**, never the value.
- Commits: explicit paths, never `-A`. Do not push to `main` (`main` deploys). Work on a feature branch off Slice 1's merge (or `main` if Slice 1 already landed).
- `tsc --noEmit` is a no-op in `pwa/`. Type-check with `npm run typecheck`.
- Ledger states stay `open | fixed with test | needs live proof | not reproducible`. A-134 stays `open`. Do not invent a fifth state.

## File map

| File                                                 | Change | Responsibility                                              |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `scripts/check-pwa-env.mjs`                          | create | Validate `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`     |
| `scripts/check-pwa-env.test.mjs`                     | create | Missing, http, placeholder host, short key, valid pair      |
| `scripts/check-deploy-contract.test.mjs`             | create | Pin deploy.yml: no CI wait, fail-not-skip, env check, smoke |
| `pwa/src/lib/supabaseEnv.ts`                         | create | `assertProductionSupabaseEnv`                               |
| `pwa/src/lib/supabaseEnv.test.ts`                    | create | Prod throw vs dev/demo keep placeholders                    |
| `pwa/src/lib/supabase.ts`                            | modify | Call the assert before `createClient`                       |
| `.github/workflows/deploy.yml`                       | modify | Gate `exit 1`; run env checker; smoke + receipt             |
| `.github/workflows/ci.yml`                           | modify | Add the new `node --test` files                             |
| `supabase/functions/mcp-server/lib/health.ts`        | create | Env + token-store ping                                      |
| `supabase/functions/mcp-server/lib/health.test.ts`   | create | 200 stub ping; 503 missing env / ping throw                 |
| `supabase/functions/mcp-server/lib/handler.ts`       | modify | `/health` uses `mcpHealthStatus`                            |
| `supabase/functions/mcp-server/lib/protocol.test.ts` | modify | Closed-port `/health` is 503 and leaks nothing              |
| `docs/deploy.md`                                     | modify | Fail-not-skip, rollback, sweep operator queries             |
| `AGENTS.md`                                          | modify | `node --test` line includes the new files                   |
| `docs/roadmaps/release-ledger.md`                    | modify | Slice 2 states                                              |

---

### Task 1: PWA env checker (A-24)

**Files:**

- Create: `scripts/check-pwa-env.mjs`
- Create: `scripts/check-pwa-env.test.mjs`
- Modify: `.github/workflows/ci.yml` (database job `node --test` line)
- Modify: `AGENTS.md` (the two `node --test scripts/...` command lines)

**Interfaces:**

- Consumes: `env: NodeJS.Dict<string> | NodeJS.ProcessEnv` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- Produces: `validatePwaEnv(env): { ok: true } | { ok: false; message: string }` — `message` names the variable, never the value. CLI exits 1 on `{ ok: false }`.

- [ ] **Step 1: Write the failing tests**

`scripts/check-pwa-env.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePwaEnv } from "./check-pwa-env.mjs";

const VALID_URL = "https://abcdefghijklmnop.supabase.co";
const VALID_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("missing URL fails and names the var, not a value", () => {
  const r = validatePwaEnv({ VITE_SUPABASE_ANON_KEY: VALID_KEY });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
  assert.equal(r.message.includes(VALID_KEY), false);
});

test("http URL fails", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: "http://abcdefghijklmnop.supabase.co",
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
});

test("placeholder host fails even though it is https supabase.co", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: "https://placeholder.supabase.co",
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
  assert.equal(r.message.includes("placeholder.supabase.co"), false);
});

test("short anon key fails and does not echo it", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: VALID_URL,
    VITE_SUPABASE_ANON_KEY: "placeholder-anon-key",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_ANON_KEY/);
  assert.equal(r.message.includes("placeholder-anon-key"), false);
});

test("valid pair passes", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: VALID_URL,
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.deepEqual(r, { ok: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-pwa-env.test.mjs`

Expected: FAIL, `Cannot find module` or `validatePwaEnv is not exported`.

- [ ] **Step 3: Write minimal implementation**

`scripts/check-pwa-env.mjs`:

```js
import { pathToFileURL } from "node:url";

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function validatePwaEnv(env) {
  const urlRaw = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  const problems = [];

  if (!urlRaw) {
    problems.push("VITE_SUPABASE_URL is missing");
  } else {
    let parsed;
    try {
      parsed = new URL(urlRaw);
    } catch {
      problems.push("VITE_SUPABASE_URL is not a URL");
    }
    if (parsed) {
      if (parsed.protocol !== "https:") {
        problems.push("VITE_SUPABASE_URL must be https");
      }
      if (
        parsed.hostname === "placeholder.supabase.co" ||
        !parsed.hostname.endsWith(".supabase.co")
      ) {
        problems.push("VITE_SUPABASE_URL host is not a Supabase project");
      }
    }
  }

  if (!key) {
    problems.push("VITE_SUPABASE_ANON_KEY is missing");
  } else if (!JWT_RE.test(key)) {
    problems.push("VITE_SUPABASE_ANON_KEY is not a JWT");
  }

  if (problems.length > 0) return { ok: false, message: problems.join("; ") };
  return { ok: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = validatePwaEnv(process.env);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}
```

Add `scripts/check-pwa-env.test.mjs` to the database job in `.github/workflows/ci.yml`:

```yaml
- run: node --test scripts/release-ledger.test.mjs scripts/strength-mcp-relay.test.mjs scripts/strength-tunnel-config.test.mjs scripts/strength-tunnel-supervisor.test.mjs scripts/check-pwa-env.test.mjs
```

Mirror that line in both `node --test` command blocks in `AGENTS.md` (the short one around line 734 and the CI matrix one around line 762).

- [ ] **Step 4: Run tests**

Run: `node --test scripts/check-pwa-env.test.mjs`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-pwa-env.mjs scripts/check-pwa-env.test.mjs .github/workflows/ci.yml AGENTS.md
git commit -m "$(cat <<'EOF'
Reject a PWA build whose Supabase env is missing or placeholder.

A typo in the Pages variables can no longer ship a client that cannot
authenticate. The checker names the variable, never the value.
EOF
)"
```

---

### Task 2: Production client refuses placeholders (A-24)

**Files:**

- Create: `pwa/src/lib/supabaseEnv.ts`
- Create: `pwa/src/lib/supabaseEnv.test.ts`
- Modify: `pwa/src/lib/supabase.ts`

**Interfaces:**

- Consumes: `url` / `anonKey` from `import.meta.env`, plus `prod` (`import.meta.env.PROD`) and `demo` (`VITE_DEMO === "1"`)
- Produces: `assertProductionSupabaseEnv(url, anonKey, prod, demo): void` — throws in production non-demo when either value is missing or still the placeholder string. Dev and demo return without throwing.

- [ ] **Step 1: Write the failing tests**

`pwa/src/lib/supabaseEnv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertProductionSupabaseEnv } from "./supabaseEnv";

const URL = "https://abcdefghijklmnop.supabase.co";
const KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("assertProductionSupabaseEnv", () => {
  it("throws in production when the URL is the placeholder", () => {
    expect(() =>
      assertProductionSupabaseEnv(
        "https://placeholder.supabase.co",
        KEY,
        true,
        false,
      ),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it("throws in production when the anon key is missing", () => {
    expect(() =>
      assertProductionSupabaseEnv(URL, undefined, true, false),
    ).toThrow(/VITE_SUPABASE_ANON_KEY/);
  });

  it("does not throw in dev with placeholders", () => {
    expect(() =>
      assertProductionSupabaseEnv(
        "https://placeholder.supabase.co",
        "placeholder-anon-key",
        false,
        false,
      ),
    ).not.toThrow();
  });

  it("does not throw in demo mode", () => {
    expect(() =>
      assertProductionSupabaseEnv(undefined, undefined, true, true),
    ).not.toThrow();
  });

  it("does not throw for a real production pair", () => {
    expect(() =>
      assertProductionSupabaseEnv(URL, KEY, true, false),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && npm test -- --run src/lib/supabaseEnv.test.ts`

Expected: FAIL, cannot resolve `./supabaseEnv`.

- [ ] **Step 3: Write minimal implementation**

`pwa/src/lib/supabaseEnv.ts`:

```ts
const PLACEHOLDER_URL = "https://placeholder.supabase.co";
const PLACEHOLDER_KEY = "placeholder-anon-key";

export function assertProductionSupabaseEnv(
  url: string | undefined,
  anonKey: string | undefined,
  prod: boolean,
  demo: boolean,
): void {
  if (!prod || demo) return;
  if (!url || url === PLACEHOLDER_URL) {
    throw new Error("Production build is missing VITE_SUPABASE_URL");
  }
  if (!anonKey || anonKey === PLACEHOLDER_KEY) {
    throw new Error("Production build is missing VITE_SUPABASE_ANON_KEY");
  }
}
```

In `pwa/src/lib/supabase.ts`, import and call it **before** `createClient`, keeping the placeholder client for dev/demo:

```ts
import { assertProductionSupabaseEnv } from "./supabaseEnv";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const demoMode = import.meta.env.VITE_DEMO === "1";

assertProductionSupabaseEnv(url, anonKey, import.meta.env.PROD, demoMode);
```

Do not change `supabaseConfigured`. Do not remove the placeholder `createClient` arguments — they remain the import-safe path for `npm run dev`.

- [ ] **Step 4: Run tests**

Run: `cd pwa && npm test -- --run src/lib/supabaseEnv.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pwa/src/lib/supabaseEnv.ts pwa/src/lib/supabaseEnv.test.ts pwa/src/lib/supabase.ts
git commit -m "$(cat <<'EOF'
Refuse a production PWA client built on placeholder Supabase env.

Dev and demo still boot without a project. A shipped bundle cannot.
EOF
)"
```

---

### Task 3: Deploy contract — fail not skip, no CI wait (A-25, A-134)

**Files:**

- Create: `scripts/check-deploy-contract.test.mjs`
- Modify: `.github/workflows/deploy.yml` (header comment + supabase `gate` step)
- Modify: `.github/workflows/ci.yml` (`node --test` line — add this file next to Task 1's)
- Modify: `AGENTS.md` (`node --test` lines, same)

**Interfaces:**

- Consumes: the text of `.github/workflows/deploy.yml`
- Produces: assertions that (1) there is no `workflow_run` and no job named `ci` as a `needs:` of `pages` or `supabase`, (2) the gate step `exit 1`s when secrets are missing, (3) pages still has `needs.supabase.result != 'failure'`, (4) the supabase job `if:` is still `needs.changes.outputs.supabase == 'true'` so a pwa-only push skips rather than fails.

- [ ] **Step 1: Write the failing tests**

`scripts/check-deploy-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yaml = () => readFile(join(root, ".github/workflows/deploy.yml"), "utf8");

test("deploy does not wait on CI", async () => {
  const text = await yaml();
  assert.equal(text.includes("workflow_run"), false);
  assert.match(text, /^on:\n  push:\n    branches: \[main\]/m);
  assert.equal(/\n\s+needs:.*\bci\b/.test(text), false);
});

test("a supabase-path push with missing secrets fails the supabase job", async () => {
  const text = await yaml();
  assert.match(text, /if: needs\.changes\.outputs\.supabase == 'true'/);
  assert.match(text, /exit 1/);
  assert.equal(text.includes('echo "on=false"'), true);
  assert.equal(
    /on=false[\s\S]*exit 0/.test(text),
    false,
    "missing secrets must not skip-success",
  );
});

test("pages still waits on a failed supabase job and proceeds when it is skipped", async () => {
  const text = await yaml();
  assert.match(text, /needs: \[changes, supabase\]/);
  assert.match(text, /needs\.supabase\.result != 'failure'/);
  assert.match(text, /always\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-deploy-contract.test.mjs`

Expected: FAIL on `exit 1` / skip-success (`on=false` currently prints a notice and the step exits 0).

- [ ] **Step 3: Write minimal implementation**

Replace the supabase `gate` step body in `.github/workflows/deploy.yml` with:

```yaml
- id: gate
  shell: bash
  run: |
    if [ -n "$SUPABASE_ACCESS_TOKEN" ] && [ -n "$SUPABASE_DB_PASSWORD" ] && [ -n "$SUPABASE_PROJECT_REF" ]; then
      echo "on=true" >> "$GITHUB_OUTPUT"
    else
      echo "on=false" >> "$GITHUB_OUTPUT"
      echo "::error title=Supabase deploy blocked::SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD (repository secrets) and SUPABASE_PROJECT_REF (repository variable) are not all set. A change under supabase/ cannot publish without them — docs/deploy.md."
      exit 1
    fi
```

Rewrite the file-level comment that currently says missing settings print a notice and skip. New text:

```
# Three jobs. `changes` looks at the diff. `supabase` pushes migrations and
# edge functions when anything under supabase/ changed. If those paths
# changed and the three deploy settings are missing, the job FAILS so Pages
# cannot publish a client against a schema/function set that did not go out.
# If supabase/ did not change, the job is skipped and Pages may still publish.
# There is no wait on `ci.yml`: GitHub Actions CI billing currently fails that
# workflow automatically, and a release must not wait on a job that cannot run.
```

Do **not** add `workflow_run`. Do **not** add a `require_ci` input. Leave `pages` `if:` as it is (`always()` + pwa changed + supabase not failure/cancelled).

Add `scripts/check-deploy-contract.test.mjs` to the same `node --test` lines Task 1 edited.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/check-deploy-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-deploy-contract.test.mjs .github/workflows/deploy.yml .github/workflows/ci.yml AGENTS.md
git commit -m "$(cat <<'EOF'
Fail the backend deploy when supabase/ changed without secrets.

A skipped-success job was letting Pages publish a client that needed
schema that never went out. Deploy still does not wait on CI.
EOF
)"
```

---

### Task 4: Env check and smoke receipt in deploy.yml (A-24 wire, A-135)

**Files:**

- Modify: `scripts/check-deploy-contract.test.mjs` (add assertions)
- Modify: `.github/workflows/deploy.yml` (`pages` job)

**Interfaces:**

- Consumes: Task 1's `node scripts/check-pwa-env.mjs` CLI; Task 3's pages job
- Produces: env checker runs in the pages job with the same `env:` as `npm run build`, immediately before it; a `smoke` step after `peaceiris/actions-gh-pages` curls Pages (fail on non-200) and MCP `/health` when `SUPABASE_PROJECT_REF` is set; prints a receipt of sha, run id, supabase job result, HTTP codes; no secrets in that output.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check-deploy-contract.test.mjs`:

```js
test("pages runs the PWA env checker before vite build", async () => {
  const text = await yaml();
  const pages = text.slice(text.indexOf("name: publish PWA"));
  const checkAt = pages.indexOf("node scripts/check-pwa-env.mjs");
  const buildAt = pages.indexOf("npm run build");
  assert.ok(checkAt >= 0, "missing check-pwa-env.mjs");
  assert.ok(buildAt > checkAt, "env checker must run before npm run build");
});

test("pages smokes the published app and prints a receipt", async () => {
  const text = await yaml();
  const afterPublish = text.slice(text.indexOf("peaceiris/actions-gh-pages"));
  assert.match(afterPublish, /curl /);
  assert.match(afterPublish, /github\.sha/);
  assert.match(afterPublish, /github\.run_id/);
  assert.equal(afterPublish.includes("SUPABASE_ACCESS_TOKEN"), false);
  assert.equal(afterPublish.includes("SUPABASE_DB_PASSWORD"), false);
  assert.equal(afterPublish.includes("SERVICE_ROLE"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-deploy-contract.test.mjs`

Expected: FAIL, missing `check-pwa-env.mjs` / `curl` after gh-pages.

- [ ] **Step 3: Write minimal implementation**

In the `pages` job of `.github/workflows/deploy.yml`, insert **before** `- run: npm run build`:

```yaml
- run: node scripts/check-pwa-env.mjs
  env:
    VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
    VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}
```

Keep the existing `npm run build` `env:` block unchanged (it still needs those vars plus Sentry/version stamps).

After the `peaceiris/actions-gh-pages` step, add:

```yaml
- name: smoke
  env:
    PAGES_URL: ${{ vars.PAGES_URL }}
    SUPABASE_PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}
  run: |
    set -euo pipefail
    pages_url="${PAGES_URL:-https://coltbradley.github.io/strength-tracker/}"
    pages_code=$(curl -sS -o /tmp/pages-body -w '%{http_code}' "$pages_url")
    echo "pages_http=$pages_code"
    if [ "$pages_code" != "200" ]; then
      echo "::error::Pages smoke failed ($pages_code)"
      exit 1
    fi
    mcp_code=skipped
    if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
      mcp_url="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/mcp-server/health"
      mcp_code=$(curl -sS -o /tmp/mcp-health -w '%{http_code}' "$mcp_url")
      echo "mcp_http=$mcp_code"
      if [ "$mcp_code" != "200" ]; then
        echo "::error::MCP /health smoke failed ($mcp_code)"
        exit 1
      fi
    else
      echo "MCP smoke skipped: SUPABASE_PROJECT_REF unset"
    fi
    echo "receipt sha=${{ github.sha }} run=${{ github.run_id }} supabase_job=${{ needs.supabase.result }} pages_http=$pages_code mcp_http=$mcp_code"
```

Do not curl with a service-role key. Do not print `vars.VITE_SUPABASE_ANON_KEY`.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/check-deploy-contract.test.mjs`

Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-deploy-contract.test.mjs .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
Smoke the published PWA and refuse a Pages build with placeholder env.

The job log carries sha, run id, and HTTP codes. Secrets stay out of it.
EOF
)"
```

---

### Task 5: MCP /health pings env and the token store (A-136)

**Files:**

- Create: `supabase/functions/mcp-server/lib/health.ts`
- Create: `supabase/functions/mcp-server/lib/health.test.ts`
- Modify: `supabase/functions/mcp-server/lib/handler.ts` (`/health` branch)
- Modify: `supabase/functions/mcp-server/lib/protocol.test.ts` (existing `/health` test)

**Interfaces:**

- Consumes: `Deno.env` `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; `getClient()`; `from("mcp_tokens").select("id", { head: true, count: "exact" }).limit(1)`
- Produces: `mcpHealthStatus(ping?: HealthPing): Promise<200 | 503>`; `HEALTH_OK` / `HEALTH_DOWN` bodies with keys `server`, `status`, `transport` only. 503 never includes a Postgres / fetch error string. `/health` stays unauthenticated and before `resolveCaller`.

- [ ] **Step 1: Write the failing tests**

`supabase/functions/mcp-server/lib/health.test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { HEALTH_DOWN, HEALTH_OK, mcpHealthStatus } from "./health.ts";

Deno.test(
  "stub ping success is 200 and the ok body has no user data",
  async () => {
    const code = await mcpHealthStatus(async () => {});
    assertEquals(code, 200);
    assertEquals(Object.keys(HEALTH_OK).sort(), [
      "server",
      "status",
      "transport",
    ]);
    assertEquals(HEALTH_OK.status, "ok");
  },
);

Deno.test("missing env is 503 even if ping would succeed", async () => {
  const prevUrl = Deno.env.get("SUPABASE_URL");
  const prevKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("SUPABASE_URL");
  try {
    const code = await mcpHealthStatus(async () => {});
    assertEquals(code, 503);
    assertEquals(HEALTH_DOWN.status, "unavailable");
    assertEquals(
      JSON.stringify(HEALTH_DOWN).includes("Missing required env"),
      false,
    );
  } finally {
    if (prevUrl !== undefined) Deno.env.set("SUPABASE_URL", prevUrl);
    if (prevKey !== undefined) {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", prevKey);
    }
  }
});

Deno.test(
  "ping throw is 503 and the body does not carry the error",
  async () => {
    const code = await mcpHealthStatus(async () => {
      throw new Error("password authentication failed for user postgres");
    });
    assertEquals(code, 503);
    assertEquals(
      JSON.stringify(HEALTH_DOWN).includes("password authentication failed"),
      false,
    );
  },
);
```

In `protocol.test.ts`, change the existing `/health` test (closed-port `SUPABASE_URL` already set at module load) from 200 to 503:

```ts
Deno.test(
  "/health answers without a credential and leaks nothing",
  async () => {
    const res = await handleRequest(
      new Request(`${URL_}/health`, { method: "GET" }),
    );
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.status, "unavailable");
    assertEquals(Object.keys(body).sort(), ["server", "status", "transport"]);
    assertEquals(JSON.stringify(body).includes("ECONNREFUSED"), false);
  },
);
```

Reason the old 200 must move: protocol tests point `SUPABASE_URL` at `http://127.0.0.1:1`, which is the unreachable-store fixture. A real ping there is exactly the false-green A-136 was about.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/mcp-server && deno test --allow-env --allow-net lib/health.test.ts lib/protocol.test.ts`

Expected: FAIL, `health.ts` missing; protocol `/health` still 200.

- [ ] **Step 3: Write minimal implementation**

`supabase/functions/mcp-server/lib/health.ts`:

```ts
import { getClient } from "./db.ts";

export type HealthPing = () => Promise<void>;

export const HEALTH_OK = {
  status: "ok",
  server: "strength-tracker",
  transport: "streamable-http",
} as const;

export const HEALTH_DOWN = {
  status: "unavailable",
  server: "strength-tracker",
  transport: "streamable-http",
} as const;

export async function defaultHealthPing(): Promise<void> {
  const client = getClient();
  const { error } = await client
    .from("mcp_tokens")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) throw new Error("token store unreachable");
}

export async function mcpHealthStatus(
  ping: HealthPing = defaultHealthPing,
): Promise<200 | 503> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return 503;
  try {
    await ping();
    return 200;
  } catch {
    console.error(JSON.stringify({ msg: "health ping failed" }));
    return 503;
  }
}
```

In `handler.ts`, import `HEALTH_DOWN`, `HEALTH_OK`, `mcpHealthStatus` from `./health.ts` and replace the `/health` branch:

```ts
if (req.method === "GET" && url.pathname.endsWith("/health")) {
  const code = await mcpHealthStatus();
  return json(code, code === 200 ? HEALTH_OK : HEALTH_DOWN);
}
```

Keep it before `resolveCaller`. Do not put `error.message` on the body. Do not add user counts.

- [ ] **Step 4: Run tests**

Run: `cd supabase/functions/mcp-server && deno check index.ts && deno test --allow-env --allow-net`

Expected: PASS, including health.test.ts and protocol.test.ts.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp-server/lib/health.ts supabase/functions/mcp-server/lib/health.test.ts supabase/functions/mcp-server/lib/handler.ts supabase/functions/mcp-server/lib/protocol.test.ts
git commit -m "$(cat <<'EOF'
Make MCP /health fail when env or the token store is down.

A 200 now means the function can actually look up tokens, not that the
isolate answered. The body still carries no user data.
EOF
)"
```

---

### Task 6: Rollback and sweep operator docs (A-135 docs, A-137, A-138)

**Files:**

- Modify: `docs/deploy.md`

**Interfaces:**

- Produces: a **Rollback** section (Pages revert, forward-only migrations, function redeploy by SHA); **Automating the Supabase half** copy matches fail-not-skip; an **Is the sweep alive?** subsection that reuses the existing inspection SQL and states that a missing Vault row means the sweep does nothing and says so. No pager. No new table.

- [ ] **Step 1: Write the doc (no separate failing test — the ledger task pins the rows)**

In `docs/deploy.md`:

1. **Automating the Supabase half** (currently "without them it prints a notice and skips"): replace with fail-not-skip. A `supabase/` push without the three settings fails the supabase job and Pages does not publish. A `pwa/`-only push still skips supabase and publishes.

2. Add after **Post-deploy smoke test**:

```markdown
## Rollback

- **PWA:** revert the `gh-pages` commit, or revert the `main` commit that
  triggered Pages and re-run `deploy`. Device IndexedDB is untouched either
  way.
- **Migrations:** do not roll back. Add a new numbered migration. Applied
  migrations are append-only; a database undo is not a release lever this
  project has.
- **Functions:** `supabase functions deploy <name>` from the previous
  known-good SHA (`mcp-server`, `coach`, `push-alerts`, `endurance-sync`).
  `mcp-server` stays `--no-verify-jwt`.
```

3. Under **Prompt delivery (the sweep)** / **Checking it**, add:

```markdown
### Is the sweep alive?

There is no pager. If prompts stop arriving while the app is closed, run
the queries above. A missing Vault row (`project_url` or `sweep_secret`)
means `run_alert_sweep()` does nothing and raises a notice each tick —
that is success-with-no-work, not a 401 storm. Rest alerts are a different
path (`POST /schedule`) and are unaffected. In-app prompts on foreground
keep working even if the cron is gone.
```

Do not claim the cron is configured in production unless "Where production stands" already says so. Do not add a GitHub Actions cron as a substitute pager.

- [ ] **Step 2: Re-read for contradiction**

Confirm the file no longer says missing settings skip-success, and that `/mcp-server/health` is described as 200 only when env + token store work (the existing smoke curl bullet).

- [ ] **Step 3: Commit**

```bash
git add docs/deploy.md
git commit -m "$(cat <<'EOF'
Document Pages revert, forward-only migrations, and sweep inspection.

A green deploy is no longer the only record of what shipped. The sweep
still has no pager; a missing Vault row stays a notice, not an alert.
EOF
)"
```

---

### Task 7: Ledger and Slice 2 exit

**Files:**

- Modify: `docs/roadmaps/release-ledger.md`

**Interfaces:**

- Ledger states remain `open | fixed with test | needs live proof | not reproducible`.

- [ ] **Step 1: Update ledger rows this slice closed**

Set:

- A-24 `fixed with test` — `scripts/check-pwa-env.test.mjs`, `pwa/src/lib/supabaseEnv.test.ts`. Rollback: revert the checker step and `assertProductionSupabaseEnv`.
- A-25 `fixed with test` — `scripts/check-deploy-contract.test.mjs`. Rollback: restore skip-success gate (do not).
- A-26 unchanged (`fixed with test`).
- A-134 stay `open`. Production proof cell: `deferred: GitHub Actions CI billing; deploy must not wait`. Rollback: `—`. Do not invent a fifth state.
- A-135 `fixed with test` — `scripts/check-deploy-contract.test.mjs` smoke assertions; `docs/deploy.md` Rollback. Production proof: the next `deploy` job log's `receipt sha=` line.
- A-136 `fixed with test` — `supabase/functions/mcp-server/lib/health.test.ts`. Production proof: `curl .../health` is 200 on the live function. Rollback: revert `health.ts`.
- A-137 `needs live proof` — regression test `docs/deploy.md` "Is the sweep alive?". Production proof: the `cron.job` / `cron.job_run_details` queries on the live project. Until someone runs them, the production-proof cell may stay the query names rather than output.
- A-138 same as A-137 (no pager; operator queries are the signal).

Do not mark Slice 1 rows. Do not mark A-139+.

- [ ] **Step 2: Run the ledger checker**

Run: `node scripts/check-release-ledger.mjs`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmaps/release-ledger.md
git commit -m "$(cat <<'EOF'
Record Slice 2 release-contract fixes on the release ledger.

A-134 stays open: deploy must not wait on billed-out CI.
EOF
)"
```

---

## Out of scope

- Slice 1 admission / tenant / composite FKs / coach confirm (`docs/superpowers/plans/2026-09-21-phase-1-admission-tenant.md`)
- Phase 2 outbox / phone / browser E2E
- Repairing GitHub Actions billing, `workflow_run`, `require_ci`
- A-26 coach CI tests (already fixed)
- Pushing to `main`

## Self-review

1. **Spec coverage:** A-24 T1+T2+T4, A-25 T3, A-26 none, A-134 T3+T7 (stays open), A-135 T4+T6, A-136 T5, A-137/A-138 T6+T7.
2. **Placeholders:** none. Function names, YAML, and commands are exact.
3. **Types:** `validatePwaEnv`, `assertProductionSupabaseEnv`, `mcpHealthStatus`, `HEALTH_OK` / `HEALTH_DOWN` match across tasks.
