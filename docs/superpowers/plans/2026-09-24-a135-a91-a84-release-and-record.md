# A-135, A-91, A-84: served-build receipt, zero-row close, atomic plan replacement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last Phase 1 item (A-135) and two Phase 2 training-record
items (A-91, A-84), each with a regression test at the evidence layer the
roadmap names.

**Architecture:** Three independent slices, one commit each. A-135 makes the
PWA build emit `build.json` carrying its SHA and makes the deploy smoke poll
the SERVED file until it matches `github.sha`. A-91 makes the outbox's update
transport return the row it changed, so a zero-row close becomes a dead but
retryable item instead of silently leaving the queue. A-84 moves
`set_training_plan`'s supersede + insert + phases into one owner-scoped
Postgres function so it lands or rolls back whole.

**Tech Stack:** Vite (PWA build), GitHub Actions bash, supabase-js/PostgREST,
vitest, PGlite (`scripts/validate-db.mjs`), Deno MCP tools.

## Global Constraints

- Migrations are additive: one new numbered file, never edit an applied one.
- `validate-db.mjs` and `check-selects.mjs` must pass after the schema change.
- The MCP service role bypasses RLS; the new function must check `p_user_id`
  itself and every write must stamp it.
- A dead outbox item must stay VISIBLE and retryable when the cause is state
  outside the payload (`deadKind` → `blocked`), never silently dropped.
- Nothing in the deploy smoke may reference a secret.

---

### Task 1: A-135 served-build readback

**Files:**

- Modify: `pwa/vite.config.ts` (add a `buildStamp` plugin that emits `build.json`)
- Modify: `.github/workflows/deploy.yml` (smoke step polls `build.json`)
- Test: `scripts/check-deploy-contract.test.mjs`

**Interfaces:** Produces `<PAGES_URL>build.json` = `{"sha": "<VITE_BUILD_SHA or null>"}`.
`build.json` is not precached (the service worker's globPatterns exclude json).

- [ ] **Step 1: failing contract test** — append to `check-deploy-contract.test.mjs`:

```js
test("pages smoke reads the served build SHA back, not the one it meant to publish", async () => {
  const text = await yaml();
  const smoke = text.slice(text.indexOf("- name: smoke"));
  assert.match(smoke, /build\.json/, "smoke must fetch the served build stamp");
  assert.match(smoke, /served_sha/, "smoke must compare a served SHA");
  assert.match(
    smoke,
    /served_sha" != "\$\{\{ github\.sha \}\}"|served_sha" = "\$\{\{ github\.sha \}\}"/,
  );
});

test("the PWA build emits build.json from VITE_BUILD_SHA", async () => {
  const cfg = await readFile(
    new URL("../pwa/vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(cfg, /fileName: "build\.json"/);
  assert.match(cfg, /VITE_BUILD_SHA/);
});
```

- [ ] **Step 2:** `node --test scripts/check-deploy-contract.test.mjs` → both FAIL.
- [ ] **Step 3: plugin** — in `pwa/vite.config.ts` add before `export default`:

```ts
// The deploy smoke reads this back from the SERVED site and compares it to
// the commit it meant to publish (A-135). Not precached: json is outside the
// service worker's globPatterns, so it always reflects what Pages serves.
const buildStamp = {
  name: "build-stamp",
  apply: "build" as const,
  generateBundle(this: {
    emitFile: (f: { type: "asset"; fileName: string; source: string }) => void;
  }) {
    this.emitFile({
      type: "asset",
      fileName: "build.json",
      source: JSON.stringify({ sha: process.env.VITE_BUILD_SHA || null }),
    });
  },
};
```

and add `buildStamp,` to `plugins`.

- [ ] **Step 4: smoke** — in the `smoke` step, after the Pages 200 check, add a
      poll (Pages publishes asynchronously after the gh-pages push):

```bash
          served_sha=unknown
          for attempt in $(seq 1 40); do
            served_sha=$(curl -sS --max-time 15 "${pages_url}build.json?run=${{ github.run_id }}-$attempt" \
              | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p' || true)
            [ "$served_sha" = "${{ github.sha }}" ] && break
            sleep 15
          done
          echo "served_sha=$served_sha"
          if [ "$served_sha" != "${{ github.sha }}" ]; then
            echo "::error::Pages is serving ${served_sha:-nothing}, not ${{ github.sha }}"
            exit 1
          fi
```

and add `served_sha=$served_sha` to the receipt line.

- [ ] **Step 5:** contract tests PASS; `VITE_BUILD_SHA=abc123 npm --prefix pwa run build && cat pwa/dist/build.json` prints `{"sha":"abc123"}`.
- [ ] **Step 6:** commit `fix: read the served build SHA back in the deploy smoke (A-135)`.

**Live proof:** the next deploy log's receipt has `served_sha=` equal to `sha=`.

### Task 2: A-91 zero-row session close

**Files:**

- Modify: `pwa/src/lib/sync.ts` (update transport)
- Modify: `pwa/src/lib/outbox.ts` (`classify`, `deadKind`)
- Test: `pwa/src/lib/outbox.test.ts`

**Interfaces:** A zero-row update surfaces as
`{code: "PGRST116", status: 406}` (PostgREST's own answer to `.single()`
matching no row). `classify` → `"dead"`; `deadKind("PGRST116", 406)` →
`"blocked"`, so `isRetryable` is true and Retry is offered.

- [ ] **Step 1: failing tests** in `outbox.test.ts`, using the file's fake
      transport: an update returning `{message: "0 rows", code: "PGRST116", status: 406}`
      becomes `status: "dead"`, the flush continues to the next item, and
      `isRetryable(item)` is true; `deadKind("PGRST116", 406)` is `"blocked"`.
- [ ] **Step 2:** run → FAIL (406 currently classifies as `retry` and blocks the flush).
- [ ] **Step 3:** `classify`: `if (err.code === "PGRST116") return "dead";` before
      the status checks. `deadKind`: `if (code === "PGRST116") return "blocked";`
      alongside 42501/23503, with a comment naming the parent-session case.
- [ ] **Step 4:** `sync.ts` update: `.update(patch).eq("id", id).select("id").single()`.
- [ ] **Step 5:** `npm --prefix pwa test -- --run src/lib/outbox.test.ts` PASS, full PWA suite PASS, typecheck PASS.
- [ ] **Step 6:** commit `fix: keep a session close that changed no row visible and retryable (A-91)`.

### Task 3: A-84 atomic training-plan replacement

**Files:**

- Create: `supabase/migrations/20260924190000_atomic_training_plan_replace.sql`
- Modify: `supabase/functions/mcp-server/tools/training_plan.ts` (`registerSetTrainingPlan`)
- Test: `scripts/validate-db.mjs` (new checks at the end of the training-plans section)

**Interfaces:** `public.replace_training_plan(p_user_id uuid, p_objective text,
p_starts_on date, p_ends_on date, p_source_note text, p_phases jsonb,
p_confirm_change boolean) returns jsonb`
→ `{plan_id, superseded_plan_id, superseded_plan_was_confirmed}`. Executable by
`service_role` only. Takes `pg_advisory_xact_lock` per user, reads and locks
the live plan, refuses a confirmed one without `p_confirm_change` (SQLSTATE
`P0001`, message names confirm_change), supersedes it, inserts the plan and
every phase (every column on every row), all in the function's transaction.

- [ ] **Step 1: failing checks** in `validate-db.mjs` (as `service_role`):
      replaces the live plan and writes its phases; overlapping phases roll the
      WHOLE call back (old plan still live, no new row); a confirmed live plan is
      refused without the flag and replaced with it; `authenticated` cannot
      execute it; a `p_user_id` naming another user writes only that user's rows.
- [ ] **Step 2:** `node scripts/validate-db.mjs` → FAIL (function missing).
- [ ] **Step 3:** write the migration.
- [ ] **Step 4:** `set_training_plan` calls `db.client.rpc("replace_training_plan", …)`
      and drops the compensating delete/restore; the read-back of phases stays.
- [ ] **Step 5:** `validate-db`, `check-selects`, `deno check` + `deno test` in mcp-server PASS.
- [ ] **Step 6:** commit `fix: replace a training plan in one transaction (A-84)`.

### Task 4: ledger

Mark A-135, A-91 and A-84 `fixed with test` with their test anchors; A-135's
production proof is the first receipt showing `served_sha` equal to `sha`.
