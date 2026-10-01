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

Task 3 implementation is complete in three local commits. Corrections commit replacement, void and KV relation atomically in that order; a linked void waits while its replacement remains queued, including dead, while unrelated writes continue. `retryDead()` keeps a linked void parked beside a nonretryable replacement, and can retry both in order when the replacement is retryable. The owner-bound ACK witness preserves the relation across KV cache clearing while remaining outside counts, replay, inspection and exports. `projectSetReceipt` requires exact owner-bound set UUIDs and `set_voids.set_id` values when correction relation evidence is available. In-flight/Sending is omitted because the outbox has no per-item transport evidence. Rollback has a known limitation: if older code deletes the witness after KV was cleared, the projector cannot distinguish that replacement from an ordinary set and may report it Synced when its exact UUID is read back. Focused/full PWA tests and typecheck passed; the first full rerun had one transient Focus test failure and the immediate rerun passed. No browser/phone/server readback or human acceptance is claimed; those remain coordinator/reconciliation work in Task 4/9. See the Task 3 report in the ignored execution scratch directory for commands and limitations.

## Task 4: Receipt reconciliation and visible set status

Implement Receipts plan tasks 3 and 4. Subscribe to exact successful outbox operations, preserve the existing sync callbacks, refresh owned pending snapshots, and authenticate exact set and void ID readback. Cache reads never prove server acknowledgement. Reconcile reload and ambiguous-response cases, including correction's two acknowledgements; account switch/unknown owner cannot mark synced. Add truthful accessible status in last-set summary and List, with Review details through existing outbox. Add integration tests first, run covering tests/typecheck/build, commit and update status. No production writes or migration.

## Task 5: Persist session-only units

Implement Session-local plan tasks 1 and 2 in `2026-09-30-version-d-session-local.md`. Add owner/session typed prefs in existing kv; no database version bump. Validate reads, preserve additive patching, no lost update races. Switch only this session's effective unit, survive reload, keep Settings default unchanged and authored entered load/unit consistent with total canonical kg for prefill/typed/per-hand/correction cases. Unknown-owner persistence must stand down. Tests first including reload, account isolation and invariant payloads; run covering tests/typecheck/build, commit and update status.

## Task 6: Session-local workout order

Implement Session-local tasks 3 and 4. Follow actual ExerciseEntry shape, which may represent superset members separately, and move whole adjacent pair/circuit/ramp blocks without splitting them. Preserve named-section runs and every original key exactly once, reconcile invalid/stale/duplicate order robustly. Accessible move controls, session-only persistence through prefs, selection by key, no prescription or set-index mutation; disable while correction/round write in flight. Tests first, covering pure order and integrated session behavior; run tests/typecheck/build, commit and update status. Prefer arrows over an unverified drag interaction.

Task 6 implementation is complete in pure-order commit `79bb52b` and Session integration commit `743aaf0`. The pure ordering helper treats each existing `ExerciseEntry` as canonical, groups only adjacency-required blocks (ramps, contiguous named sections and contiguous supersets), and refuses saved or requested layouts that create a new adjacency between separately declared same-letter runs. Move destinations use insertion indices after source removal; direct moves of mixed-section ramps are frozen. Session hydrates unit and order through one owner/session preference read, writes only entry keys through the existing transactional merge API, and uses owner/session/epoch guards. The selected/open/focus keys and staged drafts remain keyed to entries; no prescription or set-index mutation is involved. Reordering is disabled during correction, queued set mutations, paired-round writes, and preference writes. List actions sit below the full-width name/status row so 320px titles do not collapse.

Task 6 verification: the focused ordering, List controls, and Session integration files passed 111/111 tests; the full PWA suite passed 1,151/1,151 across 95 files. `npm run typecheck`, `npm run build`, and `git diff --check` passed. The build retains Vite's existing advisory that the main minified chunk is above 500 kB. Coordinator rendered the current worktree at 320×812 and 390×844: scroll width matched viewport width, names remained readable, and arrow targets measured 44×44. This was a local demo render, not phone acceptance or a reload/browser persistence proof. No server writes or schema changes were made. Red/green evidence and exact commands are in the ignored Task 6 report.

## Task 7: Light Train, preview and Finish

Implement Surrounding-screens plan tasks 1 and 2 in `2026-09-30-version-d-surrounding-screens.md`. Match board vocabulary and visual hierarchy with existing facts; Go -> preview -> Start remains no-write until Start, Draft/Resume/Done retain real semantics, no invented duration, server-confirmed emptiness for discard. Restyle End without changing payloads/outbox order or losing inputs. Add behavior tests for any changed behavior and rendering contracts for key states; no tests that merely assert class names. Run covering tests/typecheck/build, commit coherent slices and update status.

## Task 8: Light Program, Record and shared sheets

Implement Surrounding-screens tasks 3 and 4. Restyle existing Program/day editor, Record and relevant shared sheet surfaces consistently with board light palette and hierarchy; keep plan locks, coach/user-note distinction, groups, chart calculations, historical display provenance and offline warning behavior. Exclude dark mode, pinned goals, added bodyweight load and coach Apply. Tests first where behavior changes; retain meaningful existing tests. Run covering tests/full PWA/typecheck/build, commit per-screen changes and update status.

## Task 9: Integrated verification and documentation

Review full branch for data durability, identity, correction receipt, grouping, source-board fidelity and staged-state risks. Run full PWA/typecheck/build, E2E configuration tests, database and relevant contract checks. Start demo and inspect 320/390/402x812 and landscape, 1.3x text, long names, number pad, reduced motion, loaded/bodyweight/timed/done/per-hand/pair/List/rest/Train/Program/Record flows. Run local seeded E2E only if local services exist, otherwise report NOT RUN. Add narrow regressions for findings, record exact revision/evidence and rollback in deploy documentation, and update scoped checklists truthfully. No deployment or production acceptance claim.

## Progress

Tasks 1–9 are locally implemented, tested and independently reviewed. The final whole-branch review is pending. This status does not close phone, seeded authenticated browser, production UUID readback, deployment or human acceptance.

| Task | Result | Commits | Latest automated evidence |
| --- | --- | --- | --- |
| 1 | Controlled Focus/List header and real workout map | 9bed15c, 39e8d7a | 1,079 full PWA tests; typecheck |
| 2 | Stable Focus dock and bounded rest scene | a558ee5, 7325fd2, 1be8721, 2429aca | 126 covering tests; bounded-rest fix 86 covering tests; typecheck/build |
| 3 | Atomic correction batch, dependency gate and pure receipt projector | d573937, 82117cd, 2b5311b | 1,107 full PWA tests; typecheck |
| 4 | Exact owner-scoped receipt readback and quiet visible status | 06412b0, fcef87e, 6f3a8cf, 13f5640 | 1,124 full tests before narrow ACK-link race fix; fix 139 covering tests/typecheck |
| 5 | Transactional owner/session units with identity epoch guards | 91fee20, 977627d, 41af948 | 1,134 full tests before narrow subscription fix; fix 87 covering tests/typecheck |
| 6 | Whole-group session order with persistent preferences | 79bb52b, 743aaf0, 1053796 | 1,151 full PWA tests; typecheck/build |
| 7 | Train week, preview and Finish light cards | a02c18e, 14ac111, 49f11fe | 1,157 full PWA tests; typecheck/build |
| 8 | Actual Program calendar/day, Plan editor, Record and shared sheets | aa1465c, 831c878, 6d61e42 | 1,158 full tests before breakpoint fix; fix 55 covering tests/typecheck |
| 9 | Final Focus visual, DEV matrix, integrated verification and docs | 1c197ff, 850a91b, 3c5ba73, 7214497, 5aa29ec, f0755f4, 3b7b1d7 | Final 97 files / 1,172 tests, typecheck/build pass at 3b7b1d7; scoped reviews pass |

All tasks received fresh GPT-6 Luna spec/quality reviews. Important findings in Tasks 2–5, 8 and 9 were addressed and received scoped re-review. Task 6's insertion index, adjacency guard and narrow title width were corrected during implementation. Task 7's Train week was anchored to Today instead of Program's selected date; whole-program counters were removed from its weekly strip. Behavioral changes have RED/GREEN evidence in the ignored task reports. CSS-only changes rely on existing behavior tests plus rendered geometry, rather than class-name snapshots.

Local demo observations through Task 8 include staged values across Focus/List, same-clock rest, exact fabricated receipt labels, one replacement at the corrected set's original index, session lb while Settings stays kg, whole-pair movement with selection preserved, Go/Close without starting, RPE/note preserved through Back to Session, full 320px editor names, and Program calendar paging. Program buttons measure 44px at 320, 50.28px at 360, 54.57px at 390 and 45.71px at 402; no page horizontal overflow was observed. These are mock/browser facts. Native pointer drag did not page the week; horizontal wheel did. No phone touch or OS keyboard acceptance is inferred.

One earlier full run in Task 3 and one in Task 8 timed out in a Session test; targeted/immediate full reruns passed. The integrated run at 7214497 reproduced the preference assertion failure; test boundary assertions now retain stronger persistence checks, but no production cause is claimed. A later End-test bootstrap race was reproduced and its fixture corrected. Final coordinator source 3b7b1d7 passed all 1,172 tests, typecheck and build. See the tracked report for the failed-run history and diagnostic limits. Vite retains its existing main-chunk >500 kB advisory.

### Correction relationship ruling and rollback

Retain an owner-stamped correction relationship witness in the existing outbox after the void ACK. It is excluded from counts, replay, inspection and exports; only a known matching owner can read it. KV legitimately clears on account changes, so the witness preserves the relation across cache clearing. It establishes a relationship, never server acceptance; exact replacement and original-void evidence is still required.

Cost: one metadata row per correction remains locally until app data is cleared; there is no compaction yet. Older code may replay the void idempotently and delete the witness. If KV was already cleared, this loses the relationship and an exact replacement UUID can look like an ordinary Synced set. A rollback must not promise Review detection in that case. Do not clear IndexedDB to roll back.

The original authored-load consistency cause was fixed at `40676f5`; the recovery tool remains available. Colt waived recovery of the old failed records. Its historical NOT RUN evidence remains intact.

Final local verification, limits and rollback will be recorded in [the tracked evidence report](2026-10-01-version-d-local-verification.md). Ignored `.superpowers/sdd/2026-09-30-version-d-execution/` reports preserve detailed commands and review artifacts; they are not deployed-state evidence.
