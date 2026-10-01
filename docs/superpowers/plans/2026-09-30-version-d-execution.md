# Version D execution, 2026-09-30

Approved for implementation by Colt in this chat. Use GPT-6 Luna implementers and reviewers, write behavioral tests first, commit verified slices, and keep documentation current. Continue in `codex/version-d-light-plan` from `ed2e7f5`; do not merge, push or deploy as part of implementation.

## Authority and rulings

The Version D light design and four scoped plans are the product specification. The original board is `/private/tmp/strength-design-review/Version D - Combined.dc.html`, extracted from the user-provided ZIP. Match its light palette, round cards, Focus/List header, stable bottom controls, and clear typography using the existing React components. Use existing locally bundled fonts or system fallback, no external font dependency.

Colt explicitly waived recovery of the September 30 phone's old failed writes as an implementation/release prerequisite. Keep export/recovery tooling for future use, fix and test the underlying load/provenance errors, and leave the old record's NOT RUN evidence intact. New-data durability, correct receipt semantics, account isolation, and phone/browser verification remain required; do not claim unperformed acceptance. This supersedes the old affected-phone prerequisite in the supporting plans.

## Task 1: Focus/List header and workout map

Implement Session UI plan tasks 1 and 4, reading their text in `2026-09-30-version-d-session-ui.md`. Add controlled FocusListSwitch with accessible state and 44px hit areas. Recompose WorkoutOverview as D List using real logged rows, current entry, collapsed completed summaries, correction access, sections/ramps/pairs and explicit longer circuits. Preserve canonical Session ownership, selection, staged drafts, rest, all current logging behavior, and aggregate sync status. Write focused tests before implementation. Run covering tests and typecheck, commit header and List independently where useful. Update this execution file with observed status.

## Task 2: Light Focus dock and rest scene

Implement Session UI plan tasks 2 and 3. Read the source board and match light D layout: large movement-specific stage, stable lower load/reps/duration controls and primary action, one-tap RPE/Note/Skip/Plates (or applicable fallback), large rest clock in Focus and compact same-clock strip in List. Reuse existing sheets and Session owner; do not add state/write owners. Include bodyweight, done, time, per-hand, unequal paired round, correction, warmup and extra set. Preserve drafts across views and rest expiry cannot write. Add focused behavior tests before code. Run covering tests, typecheck and build. Commit coherent presentation slices and update status; rendered browser checks are coordinator-owned, not inferred from jsdom.

## Task 3: Atomic corrections and pure receipt projection

Implement Receipts plan tasks 1 and 2 in `2026-09-30-version-d-receipts.md`. Add durable replacement-before-void correction batching plus durable correction links in the existing outbox/kv transaction. Never update visible correction/quick RPE/plain void as accepted before durable local commit; retain/restore original on failure. Add pure setReceipt projector using exact row and operation UUIDs and current owner; local/sending/synced/review never infer success from queue totals or emptiness. No in-flight state may be invented. Write failure/offline/reload/identity tests first and run covering tests and typecheck before commits. Keep existing flusher identity/transport behavior. Update status.

Task 3 implementation is complete in two local commits. Corrections now commit replacement, void and KV relation atomically in that order; the owner-bound ACK witness preserves the relation across KV cache clearing while remaining outside queue counts, replay, inspection and exports. `projectSetReceipt` requires exact owner-bound set UUIDs and `set_voids.set_id` values, and only returns Synced when the required exact server evidence exists. In-flight/Sending is omitted because the outbox has no per-item transport evidence. Focused and full PWA tests and typecheck passed. No browser/phone/server readback or human acceptance is claimed; those remain coordinator/reconciliation work in Task 4/9. See the Task 3 report in the ignored execution scratch directory for commands and limitations.

## Task 4: Receipt reconciliation and visible set status

Implement Receipts plan tasks 3 and 4. Subscribe to exact successful outbox operations, preserve the existing sync callbacks, refresh owned pending snapshots, and authenticate exact set and void ID readback. Cache reads never prove server acknowledgement. Reconcile reload and ambiguous-response cases, including correction's two acknowledgements; account switch/unknown owner cannot mark synced. Add truthful accessible status in last-set summary and List, with Review details through existing outbox. Add integration tests first, run covering tests/typecheck/build, commit and update status. No production writes or migration.

## Task 5: Persist session-only units

Implement Session-local plan tasks 1 and 2 in `2026-09-30-version-d-session-local.md`. Add owner/session typed prefs in existing kv; no database version bump. Validate reads, preserve additive patching, no lost update races. Switch only this session's effective unit, survive reload, keep Settings default unchanged and authored entered load/unit consistent with total canonical kg for prefill/typed/per-hand/correction cases. Unknown-owner persistence must stand down. Tests first including reload, account isolation and invariant payloads; run covering tests/typecheck/build, commit and update status.

## Task 6: Session-local workout order

Implement Session-local tasks 3 and 4. Follow actual ExerciseEntry shape, which may represent superset members separately, and move whole adjacent pair/circuit/ramp blocks without splitting them. Preserve named-section runs and every original key exactly once, reconcile invalid/stale/duplicate order robustly. Accessible move controls, session-only persistence through prefs, selection by key, no prescription or set-index mutation; disable while correction/round write in flight. Tests first, covering pure order and integrated session behavior; run tests/typecheck/build, commit and update status. Prefer arrows over an unverified drag interaction.

## Task 7: Light Train, preview and Finish

Implement Surrounding-screens plan tasks 1 and 2 in `2026-09-30-version-d-surrounding-screens.md`. Match board vocabulary and visual hierarchy with existing facts; Go -> preview -> Start remains no-write until Start, Draft/Resume/Done retain real semantics, no invented duration, server-confirmed emptiness for discard. Restyle End without changing payloads/outbox order or losing inputs. Add behavior tests for any changed behavior and rendering contracts for key states; no tests that merely assert class names. Run covering tests/typecheck/build, commit coherent slices and update status.

## Task 8: Light Program, Record and shared sheets

Implement Surrounding-screens tasks 3 and 4. Restyle existing Program/day editor, Record and relevant shared sheet surfaces consistently with board light palette and hierarchy; keep plan locks, coach/user-note distinction, groups, chart calculations, historical display provenance and offline warning behavior. Exclude dark mode, pinned goals, added bodyweight load and coach Apply. Tests first where behavior changes; retain meaningful existing tests. Run covering tests/full PWA/typecheck/build, commit per-screen changes and update status.

## Task 9: Integrated verification and documentation

Review full branch for data durability, identity, correction receipt, grouping, source-board fidelity and staged-state risks. Run full PWA/typecheck/build, E2E configuration tests, database and relevant contract checks. Start demo and inspect 320/390/402x812 and landscape, 1.3x text, long names, number pad, reduced motion, loaded/bodyweight/timed/done/per-hand/pair/List/rest/Train/Program/Record flows. Run local seeded E2E only if local services exist, otherwise report NOT RUN. Add narrow regressions for findings, record exact revision/evidence and rollback in deploy documentation, and update scoped checklists truthfully. No deployment or production acceptance claim.

## Progress

- Baseline: `e1a4930` (`docs: authorize Version D implementation slices`). The initial PWA suite had 1,074 passing tests.
- Task 1 implementation committed as `9bed15c` (`feat(session): add Focus/List workout map`). The controlled switch, real logged rows and correction access in List, completed summaries, and grouping behavior are covered by focused tests. List selection remains separate from details expansion, and staged correction drafts stay owned by Session across view changes.
- Task 1 verification: focused suite 94/94 passed; full PWA suite 1,079/1,079 passed; `npm run typecheck` passed. Exact commands and red/green evidence are in `.superpowers/sdd/2026-09-30-version-d-execution/task-1-report.md`.
- Task 1 rendered browser, viewport, phone, and human acceptance remain for integrated verification. This slice adds no per-set receipt claims. Tasks 2-9 remain planned.
- Task 2 implementation committed as `a558ee5` (`feat(session): add Focus dock and rest scene`). Focused verification passed: 5 files / 126 tests, typecheck and production build. Fresh coordinator render measured reachable Log bounds at 390×844 and 320×812 with no horizontal overflow at 320. Broader text-scale, long-cue, pad/sheet and rest-scene checks remain for Task 9. Exact evidence: `.superpowers/sdd/2026-09-30-version-d-execution/task-2-report.md`.
