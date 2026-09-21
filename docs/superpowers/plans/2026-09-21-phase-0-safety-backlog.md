# Phase 0 Safety Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Tasks 1–4 implemented on `phase-0-safety-backlog`. Exit gate still needs Colt to set `COACH_ALLOWED_USERS` in production (A-02 `needs live proof`).

**Goal:** Make Phase 0's exit gate true: a reviewer can see every stop-release item's state in one ledger, and the in-app coach cannot spend money for an unapproved account.

**Architecture:** One markdown ledger is the status source of truth. A small parser/validator in `scripts/` refuses a missing stop-release row or an illegal state. Coach admission stays fail-open in code (Phase 1 owns A-02 fail-closed) but the parser becomes a tested module so production can set `COACH_ALLOWED_USERS` without touching `index.ts`. Post-merge audit items are re-verified into the ledger; this plan does not implement A-94 or any Phase 1+ fix.

**Tech Stack:** Node `node:test` for the ledger checker; Deno `jsr:@std/assert` for coach allowlist tests; Vitest for PWA skip-row tests; existing GitHub Actions `ci.yml`.

**Spec:** `docs/roadmaps/2026-09-19-consolidated-roadmap.md` Phase 0. Evidence: `docs/audits/2026-09-19-system-audit.md`.

## Global Constraints

- Do not fail-close `COACH_ALLOWED_USERS` when unset. Unset still means everyone in code. Phase 1 A-02 flips that.
- Do not implement audit fixes. Re-verify, test what already exists, mark state. A-94 stays `open`.
- Do not add `update_memory` (M-01), endurance work, or a 209-ticket programme.
- Never print, commit, or log a real user UUID or secret value. Placeholder only.
- Migrations are not touched. MCP still never writes `sets` / `sessions` / `set_voids` / `set_notes`.
- Commits: explicit paths, never `-A`. Do not push: `main` deploys.
- States are exactly: `open` | `fixed with test` | `needs live proof` | `not reproducible`.
- `tsc --noEmit` is a no-op in `pwa/`. Type-check with `npm run typecheck`.

## File map

| File                                                                                  | Change | Responsibility                                                 |
| ------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `scripts/lib/release-ledger.mjs`                                                      | create | Parse the ledger table; expand stop-release IDs; validate rows |
| `scripts/check-release-ledger.mjs`                                                    | create | CLI: exit 1 if stop-release coverage or states are wrong       |
| `scripts/release-ledger.test.mjs`                                                     | create | Parser + validator tests                                       |
| `docs/roadmaps/release-ledger.md`                                                     | create | Human ledger: one row per finding                              |
| `.github/workflows/ci.yml`                                                            | modify | Run ledger tests + checker                                     |
| `supabase/functions/coach/lib/allowlist.ts`                                           | create | `parseAllowlist`, `isCoachUserAllowed`                         |
| `supabase/functions/coach/lib/allowlist.test.ts`                                      | create | Deno tests for the door, including fail-open                   |
| `supabase/functions/coach/index.ts`                                                   | modify | Call the module at both 403 sites                              |
| `pwa/src/lib/skips.test.ts`                                                           | create | Prove skip rows carry every column                             |
| `docs/deploy.md`, `docs/setup.md`, `docs/roadmaps/2026-09-19-consolidated-roadmap.md` | modify | Production must set the allowlist; Phase 0 points here         |

---

### Task 1: Release ledger module and checker

**Files:**

- Create: `scripts/lib/release-ledger.mjs`
- Create: `scripts/check-release-ledger.mjs`
- Create: `scripts/release-ledger.test.mjs`
- Create: `docs/roadmaps/release-ledger.md`
- Modify: `.github/workflows/ci.yml` (database job, after `check-selects.mjs`)

**Interfaces:**

- Consumes: markdown table in `docs/roadmaps/release-ledger.md`
- Produces: `STOP_RELEASE_IDS: string[]`, `LEDGER_STATES`, `parseLedger(markdown: string): LedgerRow[]`, `validateLedger(rows: LedgerRow[]): string[]` (empty means ok)
- `LedgerRow`: `{ id, boundary, owner, state, regressionTest, productionProof, rollback }`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/release-ledger.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEDGER_STATES,
  STOP_RELEASE_IDS,
  parseLedger,
  validateLedger,
} from "./lib/release-ledger.mjs";

const HEADER = `| ID | Boundary | Owner | State | Regression test | Production proof | Rollback |`;
const DIV = `| --- | --- | --- | --- | --- | --- | --- |`;
const stub = (id) => `| ${id} | x | Engineering | open | — | — | — |`;

test("STOP_RELEASE_IDS covers the audit's stop-release set", () => {
  assert.equal(STOP_RELEASE_IDS[0], "A-01");
  assert.ok(STOP_RELEASE_IDS.includes("A-26"));
  assert.ok(STOP_RELEASE_IDS.includes("A-159"));
  assert.equal(new Set(STOP_RELEASE_IDS).size, STOP_RELEASE_IDS.length);
});

test("parseLedger reads one row", () => {
  const [row] = parseLedger(
    `${HEADER}\n${DIV}\n| A-02 | Coach allowlist | Colt | needs live proof | allowlist.test.ts | secrets list | redeploy |\n`,
  );
  assert.equal(row.id, "A-02");
  assert.equal(row.state, "needs live proof");
  assert.equal(row.owner, "Colt");
});

test("validateLedger reports a missing stop-release id", () => {
  const rows = STOP_RELEASE_IDS.slice(1).map((id) => ({
    id,
    boundary: "x",
    owner: "Engineering",
    state: "open",
    regressionTest: "—",
    productionProof: "—",
    rollback: "—",
  }));
  const errors = validateLedger(rows);
  assert.ok(errors.some((e) => e.includes("A-01") && e.includes("missing")));
});

test("validateLedger rejects an illegal state", () => {
  const rows = STOP_RELEASE_IDS.map((id) => ({
    id,
    boundary: "x",
    owner: "Engineering",
    state: id === "A-01" ? "fixed" : "open",
    regressionTest: "—",
    productionProof: "—",
    rollback: "—",
  }));
  const errors = validateLedger(rows);
  assert.ok(errors.some((e) => e.includes("A-01") && e.includes("state")));
});

test("validateLedger allows extra post-merge rows", () => {
  const markdown = [
    HEADER,
    DIV,
    ...STOP_RELEASE_IDS.map(stub),
    `| A-119 | Coach observations | Engineering | open | — | — | — |`,
  ].join("\n");
  assert.deepEqual(validateLedger(parseLedger(markdown)), []);
});

test("LEDGER_STATES is the Phase 0 closed set", () => {
  assert.deepEqual(
    [...LEDGER_STATES],
    ["open", "fixed with test", "needs live proof", "not reproducible"],
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/release-ledger.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` for `./lib/release-ledger.mjs`

- [ ] **Step 3: Write the module**

```js
// scripts/lib/release-ledger.mjs
export const LEDGER_STATES = Object.freeze([
  "open",
  "fixed with test",
  "needs live proof",
  "not reproducible",
]);

function range(from, to) {
  const n = (id) => Number(id.slice(2));
  const out = [];
  for (let i = n(from); i <= n(to); i++)
    out.push(`A-${String(i).padStart(2, "0")}`);
  return out;
}

/** Audit triage "Stop release / contain" expanded. Order is the audit's. */
export const STOP_RELEASE_IDS = Object.freeze([
  "A-01",
  "A-02",
  "A-03",
  "A-07",
  ...range("A-24", "A-26"),
  "A-49",
  "A-69",
  ...range("A-74", "A-76"),
  "A-84",
  ...range("A-90", "A-92"),
  "A-94",
  "A-98",
  "A-99",
  "A-107",
  ...range("A-134", "A-141"),
  "A-143",
  ...range("A-148", "A-152"),
  ...range("A-156", "A-159"),
]);

function splitRow(line) {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  if (cells.length !== 7) return null;
  const [
    id,
    boundary,
    owner,
    state,
    regressionTest,
    productionProof,
    rollback,
  ] = cells;
  if (!/^A-\d{2,3}$/.test(id)) return null;
  return {
    id,
    boundary,
    owner,
    state,
    regressionTest,
    productionProof,
    rollback,
  };
}

export function parseLedger(markdown) {
  return markdown
    .split("\n")
    .map(splitRow)
    .filter((row) => row && row.id !== "ID");
}

export function validateLedger(rows) {
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`${row.id}: duplicate row`);
    seen.add(row.id);
    if (!LEDGER_STATES.includes(row.state))
      errors.push(`${row.id}: illegal state ${JSON.stringify(row.state)}`);
    for (const col of [
      "boundary",
      "owner",
      "regressionTest",
      "productionProof",
      "rollback",
    ]) {
      if (!row[col]) errors.push(`${row.id}: empty ${col}`);
    }
  }
  for (const id of STOP_RELEASE_IDS) {
    if (!seen.has(id)) errors.push(`${id}: missing stop-release row`);
  }
  return errors;
}
```

```js
// scripts/check-release-ledger.mjs
import { readFileSync } from "node:fs";
import { parseLedger, validateLedger } from "./lib/release-ledger.mjs";

const path = new URL("../docs/roadmaps/release-ledger.md", import.meta.url);
const errors = validateLedger(parseLedger(readFileSync(path, "utf8")));
if (errors.length) {
  console.error(`release-ledger: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("release-ledger: ok");
```

- [ ] **Step 4: Seed the markdown ledger**

Create `docs/roadmaps/release-ledger.md`. Header, then one row per `STOP_RELEASE_IDS` plus the post-merge extras below. Every stop-release row starts `open` / Engineering / `—` except the ones this plan will update in later tasks.

Use these boundaries (first clause of the audit heading):

| ID    | Boundary                        |
| ----- | ------------------------------- |
| A-01  | MCP tunnel readiness            |
| A-02  | Coach allowlist                 |
| A-03  | Cross-user parent refs          |
| A-07  | Coach quota reservation         |
| A-24  | PWA env validation              |
| A-25  | Backend deploy skipped          |
| A-26  | CI coach tests                  |
| A-49  | NaN rejection                   |
| A-69  | Push SSRF                       |
| A-74  | Endurance checkpoint history    |
| A-75  | Endurance pagination            |
| A-76  | Invalid provider payload        |
| A-84  | Training-plan replacement       |
| A-90  | Prefetch auth attribution       |
| A-91  | Session close zero-row          |
| A-92  | Prescription edit adherence     |
| A-94  | Health prompt responded_at      |
| A-98  | Export completeness             |
| A-99  | Readiness second device         |
| A-107 | Log before outbox commit        |
| A-134 | Deploy after failed CI          |
| A-135 | Production verify/rollback      |
| A-136 | MCP health probe                |
| A-137 | Alert-sweep scheduler           |
| A-138 | Alert-sweep operator alert      |
| A-139 | PWA endurance-sync URL          |
| A-140 | Endurance sync scheduler        |
| A-141 | Endurance connect/revoke        |
| A-143 | Online outbox retry             |
| A-148 | Held outbox disclosure          |
| A-149 | Legacy MCP_SECRET               |
| A-150 | Fabricated assistant history    |
| A-151 | Caller-controlled confirm flags |
| A-152 | Unescaped user text into coach  |
| A-156 | Push subscription fanout        |
| A-157 | Endurance backfill window       |
| A-158 | Persisted-session project mix   |
| A-159 | Endurance credentials cleartext |

Post-merge extras (not stop-release; still required in this file so Phase 0 re-verification has a home):

| ID    | Boundary                  | Initial state |
| ----- | ------------------------- | ------------- |
| A-95  | Prompt engine unwired     | `open`        |
| A-96  | Check-in redesign         | `open`        |
| A-97  | Check-in history          | `open`        |
| A-105 | Session skips record      | `open`        |
| A-119 | Coach-observation loop    | `open`        |
| A-120 | Notes into memory extract | `open`        |

Template for each row:

```markdown
| A-01 | MCP tunnel readiness | Engineering | open | — | — | — |
```

File starts with:

```markdown
# Release ledger

Status source of truth for stop-release and Phase 0 re-verification items.
Do not scatter status in `docs/plan.md` or old implementation plans.

States: `open` · `fixed with test` · `needs live proof` · `not reproducible`.
A finding is not closed because the audit is old. Close only with a regression
test and the evidence layer the roadmap names.

| ID  | Boundary | Owner | State | Regression test | Production proof | Rollback |
| --- | -------- | ----- | ----- | --------------- | ---------------- | -------- |
```

- [ ] **Step 5: Wire CI**

In `.github/workflows/ci.yml`, database job, after `node scripts/check-selects.mjs`:

```yaml
- run: node --test scripts/release-ledger.test.mjs scripts/strength-mcp-relay.test.mjs scripts/strength-tunnel-config.test.mjs scripts/strength-tunnel-supervisor.test.mjs
- run: node scripts/check-release-ledger.mjs
```

Replace the existing `node --test scripts/strength-mcp-relay...` line so relay tests still run. Do not drop them.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
node --test scripts/release-ledger.test.mjs
node scripts/check-release-ledger.mjs
```

Expected: tests pass; `release-ledger: ok`

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/release-ledger.mjs scripts/check-release-ledger.mjs \
  scripts/release-ledger.test.mjs docs/roadmaps/release-ledger.md \
  .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
Add a Phase 0 release ledger and CI checker.

Stop-release status was scattered across the audit and old plans. One table
plus a validator makes the current state reviewable.
EOF
)"
```

---

### Task 2: Coach allowlist module (keep fail-open)

**Files:**

- Create: `supabase/functions/coach/lib/allowlist.ts`
- Create: `supabase/functions/coach/lib/allowlist.test.ts`
- Modify: `supabase/functions/coach/index.ts` (the IIFE at ~120 and the two `ALLOWED_USERS && !ALLOWED_USERS.has` sites ~712 and ~988)

**Interfaces:**

- Consumes: `COACH_ALLOWED_USERS` raw env string
- Produces:
  - `parseAllowlist(raw: string | undefined): Set<string> | null`
  - `isCoachUserAllowed(userId: string, allowlist: Set<string> | null): boolean`
- `null` = unset/blank → everyone allowed (current behaviour)
- empty `Set` = present but names nobody → refuse everyone

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/coach/lib/allowlist.test.ts
import { assertEquals } from "jsr:@std/assert@^1";
import { isCoachUserAllowed, parseAllowlist } from "./allowlist.ts";

const UID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

Deno.test("unset or blank allowlist is fail-open", () => {
  assertEquals(parseAllowlist(undefined), null);
  assertEquals(parseAllowlist(""), null);
  assertEquals(parseAllowlist("  "), null);
  assertEquals(isCoachUserAllowed(UID, null), true);
});

Deno.test("comma list admits only those uuids, case-insensitive", () => {
  const allow = parseAllowlist(` ${UID.toUpperCase()}, `);
  assertEquals(isCoachUserAllowed(UID, allow), true);
  assertEquals(isCoachUserAllowed(OTHER, allow), false);
});

Deno.test("present but empty list admits nobody", () => {
  const allow = parseAllowlist(",");
  assertEquals(allow instanceof Set, true);
  assertEquals(allow!.size, 0);
  assertEquals(isCoachUserAllowed(UID, allow), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd supabase/functions/coach && deno test lib/allowlist.test.ts`

Expected: `Module not found` for `./allowlist.ts`

- [ ] **Step 3: Write the module and switch index.ts**

```ts
// supabase/functions/coach/lib/allowlist.ts
/** WHO may use the in-app coach.
 *  `null` means the secret is unset: everyone is admitted (Phase 0 keeps
 *  this; Phase 1 A-02 fail-closes it). A present list that names nobody
 *  refuses everyone. */
export function parseAllowlist(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return new Set(
    trimmed
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

export function isCoachUserAllowed(
  userId: string,
  allowlist: Set<string> | null,
): boolean {
  if (allowlist === null) return true;
  return allowlist.has(userId.toLowerCase());
}
```

In `index.ts`, replace the IIFE with:

```ts
import { isCoachUserAllowed, parseAllowlist } from "./lib/allowlist.ts";

const ALLOWED_USERS = parseAllowlist(Deno.env.get("COACH_ALLOWED_USERS"));
```

Replace both admission checks (`handleCheckinMemory` and the chat POST) with:

```ts
if (!isCoachUserAllowed(userId, ALLOWED_USERS)) {
```

Keep the existing 403 JSON bodies unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd supabase/functions/coach && deno test lib/allowlist.test.ts && deno check index.ts && deno test
```

Expected: allowlist tests pass; `deno check` clean; existing coach suite still passes.

- [ ] **Step 5: Update ledger + docs (no secrets)**

In `docs/roadmaps/release-ledger.md`, set A-02 to:

```markdown
| A-02 | Coach allowlist | Colt | needs live proof | supabase/functions/coach/lib/allowlist.test.ts | `supabase secrets list` shows COACH_ALLOWED_USERS | Redeploy coach after setting the secret |
```

In `docs/deploy.md` coach secrets paragraph, after `COACH_ALLOWED_USERS (unset means everyone)`, add:

> Phase 0 production: this secret MUST be set to the intended fallback user's UUID (Colt's wife only). Unset still means everyone in code until Phase 1 A-02. Setting it has no append: it is the whole list every time. Do not log the value.

In `docs/setup.md` env table row for `COACH_ALLOWED_USERS`, same MUST-set sentence. Do not change the AGENTS.md fail-open rule.

In `docs/roadmaps/2026-09-19-consolidated-roadmap.md` Phase 0, change `**State:** Start here.` to `**State:** Plan at docs/superpowers/plans/2026-09-21-phase-0-safety-backlog.md. Ledger at docs/roadmaps/release-ledger.md.`

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/coach/lib/allowlist.ts \
  supabase/functions/coach/lib/allowlist.test.ts \
  supabase/functions/coach/index.ts \
  docs/roadmaps/release-ledger.md docs/deploy.md docs/setup.md \
  docs/roadmaps/2026-09-19-consolidated-roadmap.md
git commit -m "$(cat <<'EOF'
Extract coach allowlist parsing so production can set the door.

Admission still fails open when the secret is unset. The parser is now
tested, and the ledger records A-02 as needing live proof of the secret.
EOF
)"
```

---

### Task 3: Re-verify A-94, A-105, A-119

**Files:**

- Create: `pwa/src/lib/skips.test.ts`
- Modify: `docs/roadmaps/release-ledger.md` (A-94, A-105, A-119 only)
- Read, do not rewrite: `pwa/src/components/CheckInSheet.tsx`, `pwa/src/lib/skips.ts`, `pwa/src/screens/End.tsx`, `pwa/src/screens/End.test.tsx`, `pwa/src/lib/data.ts`, `pwa/src/screens/History.tsx`, `supabase/functions/mcp-server/tools/coach_observations.ts`, `supabase/migrations/20260917000000_session_skips.sql`, `supabase/migrations/20260917010000_coach_observations.sql`

**Interfaces:**

- Consumes: `readSkipsCache`, `sessionSkipRows` from `pwa/src/lib/skips.ts`
- Produces: ledger states for the three start-here IDs

Expected verification (confirm against current files; if reality differs, mark the ledger honestly and do not force a fix):

| ID    | Likely state      | Why                                                                                                        |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| A-105 | `fixed with test` | `session_skips` migration, `sessionSkipRows`, End enqueue tests                                            |
| A-119 | `fixed with test` | `coach_observations` migration, MCP tools, History delete, context block                                   |
| A-94  | `open`            | Check-in complete still does not stamp `report_prompts.responded_at`; `duePrompts` is still unwired (A-95) |

- [ ] **Step 1: Write skip-row tests (A-105 regression)**

```ts
// pwa/src/lib/skips.test.ts
import { describe, expect, it } from "vitest";
import { readSkipsCache, sessionSkipRows, type SkipRecord } from "./skips";

const rec = (over: Partial<SkipRecord> = {}): SkipRecord => ({
  entryKey: "e1",
  prescriptionId: "p1",
  exerciseId: "x1",
  scope: "exercise",
  reason: "knee",
  ...over,
});

describe("readSkipsCache", () => {
  it("treats null as none", () => {
    expect(readSkipsCache(null)).toEqual({});
  });

  it("upgrades a legacy key array", () => {
    expect(readSkipsCache(["e1"])).toEqual({
      e1: {
        entryKey: "e1",
        prescriptionId: null,
        exerciseId: "",
        scope: "exercise",
        reason: null,
      },
    });
  });

  it("passes a record through", () => {
    const map = { e1: rec() };
    expect(readSkipsCache(map)).toEqual(map);
  });
});

describe("sessionSkipRows", () => {
  it("emits every column on every row", () => {
    const [row] = sessionSkipRows("s1", [rec()]);
    expect(row).toEqual({
      id: expect.any(String),
      session_id: "s1",
      prescription_id: "p1",
      exercise_id: "x1",
      scope: "exercise",
      reason: "knee",
    });
  });

  it("keeps warmup scope and a null reason", () => {
    const [row] = sessionSkipRows("s1", [
      rec({ scope: "warmups", reason: null, prescriptionId: null }),
    ]);
    expect(row.scope).toBe("warmups");
    expect(row.reason).toBeNull();
    expect(row.prescription_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `cd pwa && npm test -- --run src/lib/skips.test.ts src/screens/End.test.tsx`

Expected: PASS (skips.ts already implements this). If fail, fix `skips.ts` only if the test names current intended behaviour; do not invent a new skip model.

- [ ] **Step 3: Confirm A-119 with existing tests, no new product surface**

Run:

```bash
cd pwa && npm test -- --run src/lib/data.test.ts src/lib/coachContext.test.ts src/lib/coachContextTrends.test.ts
cd supabase/functions/mcp-server && deno test --allow-env --allow-net tools/coach_observations.test.ts
```

Expected: PASS. History already has "WHAT THE COACH IS WATCHING" + two-tap delete (`History.tsx`). Do not add a second observation UI.

- [ ] **Step 4: Confirm A-94 is still open**

Grep `CheckInSheet.tsx` and `pwa/src` for `report_prompts` / `responded_at`. Completing a check-in must still enqueue `checkins` (and maybe episodes) without a `report_prompts` row that sets `responded_at`. If that is true, leave A-94 `open`. Do not add a stamp in this task.

- [ ] **Step 5: Update the three ledger rows**

```markdown
| A-94 | Health prompt responded_at | Engineering | open | — | — | Phase 1+ ; do not stamp from this plan |
| A-105 | Session skips record | Engineering | fixed with test | pwa/src/lib/skips.test.ts · pwa/src/screens/End.test.tsx | — | Soft-delete unused; rows are append-only |
| A-119 | Coach-observation loop | Engineering | fixed with test | supabase/functions/mcp-server/tools/coach_observations.test.ts · pwa/src/lib/data.test.ts | — | Owner DELETE on coach_observations |
```

- [ ] **Step 6: Commit**

```bash
git add pwa/src/lib/skips.test.ts docs/roadmaps/release-ledger.md
git commit -m "$(cat <<'EOF'
Record Phase 0 re-verification for skips, observations, and prompts.

Skips and coach observations already landed with the live-session merge;
the ledger now says so. Answered-prompt stamping is still missing.
EOF
)"
```

---

### Task 4: Remaining post-merge rows and Phase 0 exit

**Files:**

- Modify: `docs/roadmaps/release-ledger.md` (A-26, A-95, A-96, A-97, A-120)
- Read: `.github/workflows/ci.yml` (coach `deno test` step), `pwa/src/components/CheckInSheet.tsx`, `pwa/src/components/CheckinWeek.tsx`, `pwa/src/lib/prompts.ts`, `supabase/migrations/20260917020000_note_memory.sql`, `supabase/functions/coach/memory-extract.ts`

**Interfaces:**

- Consumes: Task 1 ledger + current code
- Produces: honest states for the rest of the post-merge set; A-26 if CI already runs coach tests

- [ ] **Step 1: Re-read and mark (no product code)**

| ID    | What to open                                                      | Mark `fixed with test` only if                                               |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A-26  | `ci.yml` coach `deno test`                                        | That step exists and `cd supabase/functions/coach && deno test` passes       |
| A-96  | CheckInSheet tags / episodes                                      | Redesign is in the running sheet, with tests                                 |
| A-97  | `CheckinWeek` on History                                          | Week grid renders from check-in reads, with tests                            |
| A-95  | `duePrompts` call sites in `pwa/src` besides `prompts.ts` / tests | Still unwired → `open`                                                       |
| A-120 | note-memory extract path                                          | Session/set notes actually reach extraction → `fixed with test`; else `open` |

Do not implement A-95 or A-120 here.

If A-26 is already green, ledger row:

```markdown
| A-26 | CI coach tests | Engineering | fixed with test | .github/workflows/ci.yml `deno test` in supabase/functions/coach | — | Revert the CI step |
```

- [ ] **Step 2: Run the checker after edits**

Run: `node scripts/check-release-ledger.mjs`

Expected: `release-ledger: ok`

- [ ] **Step 3: Production allowlist (Colt, not committed)**

Colt runs (do not paste the UUID into git or chat logs):

```bash
supabase secrets set COACH_ALLOWED_USERS="<wife-uuid>"
supabase functions deploy coach
supabase secrets list
```

Proof for the ledger: the name `COACH_ALLOWED_USERS` appears in `secrets list`. Never commit the value. After that, set A-02 `Production proof` to the date the list showed the name.

Engineering cannot close A-02 past `needs live proof` without that output.

- [ ] **Step 4: Exit-gate checklist**

Phase 0 is done when all of these are true:

1. `node scripts/check-release-ledger.mjs` exits 0
2. Every stop-release ID is in the ledger with a legal state
3. A-105 and A-119 are `fixed with test` (or an honest different state with evidence)
4. A-94 is still listed (open is fine)
5. `COACH_ALLOWED_USERS` is set in production (Colt) so an unlisted account gets 403
6. In-app coach is not enabled for friend-beta accounts

- [ ] **Step 5: Commit ledger updates (not secrets)**

```bash
git add docs/roadmaps/release-ledger.md
git commit -m "$(cat <<'EOF'
Finish Phase 0 re-verification rows on the release ledger.

Post-merge check-in, CI, and memory findings now have an explicit state
instead of inheriting the pre-merge audit wording.
EOF
)"
```

---

## Out of scope

- Phase 1 fail-closed allowlist and atomic quota (A-02 code change, A-07)
- M-01 `update_memory`
- Implementing A-94 / A-95 / A-120
- Browser E2E, deploy-blocks-on-CI, endurance product (Phases 1–5)
- Editing applied migrations

## Self-review

1. **Spec coverage:** allowlist door, post-merge re-verify starting A-94/105/119, one ledger, coach kept narrow. Exit gate is Task 4 Step 4.
2. **Placeholders:** none. States, IDs, files, and commands are exact.
3. **Types:** `parseAllowlist` / `isCoachUserAllowed` / `LedgerRow` names match across tasks.
