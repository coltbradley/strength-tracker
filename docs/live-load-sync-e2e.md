# Live load-sync end-to-end gate

A browser-level regression gate for the load path (lb/kg, plate math, authored
provenance) and for the question that caused the September 2026 sync outage:
**would the real database accept every set the UI can produce?**

It exists because unit tests and the in-memory demo both agreed with
themselves while 10 writes sat dead on a phone: the demo's mock Supabase
validates nothing, so a set whose `load_kg` disagreed with its
`entered_load`/`entered_unit` looked "Synced" in the demo and was refused by
the production trigger (`validate_entered_load_consistency`,
`20260924003054_native_load_units.sql`).

## What it does

1. Starts the demo (`VITE_DEMO=1`) of any checkout through the Vite API, with
   two build-time patches (`pwa/e2e/live-demo-plugin.mjs`, nothing in the repo
   source changes):
   - the mock's `v_resolved_prescriptions` view drops
     `entered_load`/`entered_unit` (the real view returns them), so authored
     prescriptions could never reach the app in the demo;
   - the mock's `engine` is exposed so the harness can go offline at the data
     layer (the mock never touches the network).
2. Drives Chromium (402 x 812) through one injected training day in **both
   display units**: kg- and lb-authored prescriptions, dock steps, number pad,
   plate sheet (target, bar 45 lb / 20 kg, sled 75 lb / 0), per-hand dumbbells
   and the total/per-hand toggle, bodyweight plus added load, a superset,
   Fix last in the other unit, unit switches mid-draft and mid-rest, extra
   sets, offline then online, and boundary numbers typed on the pad.
3. Records every write the app enqueues by hooking the IndexedDB `outbox`
   store (`IDBObjectStore.add/put`), independent of whether the mock accepts
   it.
4. After every step compares the screen with the arithmetic and with what was
   typed: unit label vs unit switch; stage total vs dock number; per-hand
   total = 2 x per hand; `base + 2 x plates == shown total` (or the stated
   "closest is"); typed value/unit vs `entered_load`/`entered_unit`; shown
   load vs `load_kg`; `per_side` vs the on-screen mode; set type vs the
   prescription; exercise on screen vs exercise written. Discrepancies are
   screenshotted.
5. Replays the payloads (`scripts/replay-payloads.mjs`) into PGlite built from
   the full, unmodified migration chain, inserting each set the way PostgREST
   does (`json_populate_recordset ... on conflict do nothing`, `authenticated`
   role, RLS on). Every rejection is reported with the payload and the UI step
   that produced it. It also audits the AGENTS.md invariants independently of
   the database, using exact decimal arithmetic for the expected total (the
   client rounds a binary float; the trigger rounds a decimal).

## Run it

```sh
npm --prefix pwa ci                 # once
npm --prefix scripts ci             # once (PGlite)
npx --prefix pwa playwright install chromium   # once, if no browser is installed

node pwa/e2e/live-load-sync.mjs --label branch --out /tmp/live-e2e
# same thing against another checkout:
node pwa/e2e/live-load-sync.mjs --label main --pwa-dir ../main-checkout/pwa --out /tmp/live-e2e
# options: --units lb,kg  --only barbell,superset  --shots-all  --no-replay
#          --url http://127.0.0.1:5270   (use a demo you already started)
#          --lenient   a block the checkout has no UI for is a note, not an abort
#                      (use for older checkouts; the integrated branch should not need it)
#          --allow kind,kind   do not gate on these mismatch kinds (waive a known issue)
```

Mismatches of kind `authored-drift` are informational (a prescription logged
untouched in the other unit moves by the display rounding, at most about
0.1 kg); everything else gates.

`npm --prefix pwa run test:live-load` is the same command. Exit status is 0
only when the replay accepts every op, no invariant is violated, and no screen
disagrees with what was typed. Output in `--out`:

- `live-payloads-<label>.json` - `{plan, ops}`: every outbox op, with the step
  that produced it and what was on screen (`expect`)
- `live-report-<label>.json` - per-step screen readings, mismatches, console
  errors, notes (offline outbox state, etc.)
- `replay-<label>.json` - DB rejections, invariant violations, readback diffs
- `shots-live-<label>/` - screenshots of every discrepancy (`--shots-all` for
  every step)

Replay a saved capture on its own:

```sh
node scripts/replay-payloads.mjs /tmp/live-e2e/live-payloads-branch.json
```

## Limits

- The mock Supabase is not PostgREST: server-side triggers, RLS and sync
  conflicts are exercised only by the replay, not live. A rejection found by
  the replay would be a dead write on a real device; the demo UI will still
  say "Synced".
- The harness reads the UI through accessible names and a few class names
  (`.focus-load-stage-value`, `.focus-last-set`, `.pad-key`); a redesign can
  break a selector. A selector failure aborts that scenario and is reported as
  `harness-error` with the visible buttons, never as a pass.
- It runs one device. Multi-device late-set restore and owner changes are
  covered by the Phase 2 local-Supabase gate (`pwa/e2e/README.md`).
