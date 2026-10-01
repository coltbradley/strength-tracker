# Version D local verification, 2026-10-01

Branch: `codex/version-d-light-plan`, managed checkout `/Users/coltbradley/.codex/worktrees/version-d-plan/strength-tracker`. Implementation began at `ed2e7f5`. All nine scoped tasks are locally committed, tested and independently reviewed. Final product source is `125d203`. The whole-branch review found two Important durability issues; both were fixed and accepted by one fresh scoped re-review. No findings remain open within the reviewed scope. No push, merge or deployment was performed.

The specification is [Version D light](../specs/2026-09-30-version-d-light-design.md); the [execution record](2026-09-30-version-d-execution.md) maps all task commits and review findings. GPT-6 Luna implementers and reviewers were used as requested.

## Implemented scope

Light Focus/List, controlled movement display, stable logging controls, one rest clock, real logged rows and correction access; atomic replacement-before-void corrections including saved annotations, initiating-owner capture and exact owner-scoped receipt evidence; transactional owner/session unit and whole-group order preferences; light Train, preview, Finish, Program/day editor, Record and shared sheets. No schema, dependency, IndexedDB store or database-version change was introduced. Dark mode, pinned Record goals, added bodyweight load and coach Apply remain excluded.

The failed authored-load consistency cause was already fixed at `40676f5`. Recovery tooling remains available. Colt waived recovery of the old phone records; their historical NOT RUN evidence remains intact.

## Automated evidence

- At `125d203`, the coordinator ran `npm test`: all 97 files and 1,178 tests passed (11.92 seconds). `npm run typecheck` and `npm run build` passed. The existing Vite main-chunk advisory remains. Exact logs: `/private/tmp/version-d-final-pwa-tests-4.log`, `/private/tmp/version-d-final-typecheck-4.log`, `/private/tmp/version-d-final-build-4.log`.
- Final select contract passed all 476 columns; `node scripts/check-release-ledger.mjs` passed; `node --test scripts/*.test.mjs` passed 28/28; E2E configuration checks passed 8/8.
- Earlier in this branch run, `node scripts/validate-db.mjs` passed the PGlite schema/RLS and authored-load constraints. Deno MCP 187, coach 41, push 10 and endurance-normalization 6 tests passed (244 total). These sources have not changed since those checks.
- Local seeded Phase 2 E2E is NOT RUN (exit 3): local fixture configuration is absent and Docker is unavailable. Production was not substituted.

The ignored task reports retain detailed RED/GREEN and covering-test evidence. Earlier full runs were not uniformly green: Task 3 had a timeout, and preference persistence intermittently failed in Tasks 8/9. At `7214497` it failed 1/1,172; boundary assertions in `5aa29ec` now verify a connected unpressed control, the exact owner/session write, a true identity guard, persisted value and reload. No production cause was established, so this is test hardening, not a claimed product fix. The implementer had two complete green runs after that change; the final coordinator run above is also green. If it recurs, capture every guard evaluation and await the actual transaction promise before inspecting database name/put/read.

At `f0755f4`, the full run instead failed the new Finish-payload test (1/1,172). Instrumentation reproduced a disconnected End button and two count calls before the click, with no enqueue. `3b7b1d7` replaces the one-shot server-count fixture with one real cached set and waits for its loaded summary, then asserts the connected control, synchronous enqueue and unchanged exact payload. The End file passed 9/9, followed by full-suite/typecheck/build passes from implementer and coordinator. This changes tests only.

Task 9's functional spec review passed; the initial quality gate stayed open during these failures. Scoped reviews accepted the preference hardening, relative-text-scale fix (RED/GREEN), and Finish fixture fix. All Task 9 findings are addressed. The final whole-branch review and its one fix wave are complete.

## Final review and durability fixes

The whole-branch review at `d607e4d` identified two Important findings. A correction committed before its separate annotation enqueue, so a storage failure could strand the note on the voided UUID. Queue admission also sampled the owner after an asynchronous database open, so an A-to-B account switch could stamp A's write as B. Composite owner foreign keys reject those rows; this was a risk of stranded writes, not demonstrated server misattribution.

`125d203` admits the optional annotation in the same outbox/KV transaction as the replacement, original void and relationship. Normal correction and quick RPE accept visible changes only after that complete commit. Note-add failure rolls back the whole bundle and preserves original data. All three queue admission APIs capture the initiating owner before awaiting storage; writes stay held under another or unknown live identity. Persisted identity can preserve A's note cache while live refresh is unresolved, but does not authorize replay or repopulate a signed-out account's cache.

Five new regressions failed before implementation. The final tests cover note transaction abort, offline order and database reopen, both UI producers and quick-RPE failure preservation, delayed A-to-B/A-to-unknown admission, held replay and unknown-owner cache behavior. The implementer and coordinator each passed the complete 1,178-test suite, forced typecheck and build. The independent scoped re-review accepted both findings without new breakage. Reports: `/private/tmp/version-d-final-review.md`, `/private/tmp/version-d-final-rereview.md`; the ignored `final-fix-report.md` retains RED/GREEN evidence. No further whole-branch fix wave was needed.

## Rendered browser evidence

Local `VITE_DEMO=1` browser checks use fake data and fabricated successful server responses. They do not prove authenticated server receipt or installed-phone behavior. The final source renderer was checked at 320, 390 and 402 × 812, plus 812 × 390 landscape.

| Scene | Observed result |
| --- | --- |
| Loaded warmup and current cue | 60 kg draft changed to 62.5 kg, retained through List/Focus, logged once; next warmup showed 80 kg and its current cue after hiding rest. |
| Receipt and correction | Fake Synced receipt; List historical receipt has role note. Corrected set 1 from 62.5 to 65 kg, one replacement at the original index; no extra set number. At final source, a saved note survived quick RPE 7 and then a normal 60-to-62.5 kg correction, with one live set numbered 1 and the note read back in More. |
| Rest | One clock across Focus/List, bounded rest display and reachable adjustment/RPE/note controls. Expiry does not log (behavior tests). |
| Session choices | Session lb while Settings/default inventory remained kg; moving a whole pair preserved selection. Final move placed Farmers Walk above Squat without changing the plan. Reload persistence comes from source/IndexedDB tests, not the resetting demo. |
| Entry types | Timed carry shows seconds, Done shows completion, bodyweight shows reps without added load, dumbbell/per-hand values show total provenance, unequal pair has round and member-only actions. Three-exercise circuit remains List. |
| Narrow pair | 320px and 390px, round action 68px and member-only action 44px; no horizontal page overflow. |
| Text/motion emulation | Explicit `demoTextScale=130&demoReducedMotion=1`, actual title font 41.6px versus normal 32px, motion duration 0.01ms. Enlarged pair retains 100px movement stage and scroll reaches the 44px member action. This is emulation, not OS accessibility acceptance. |
| Landscape | Movement stage retains 100px; main scroll outside that area reaches the 68px Log action. No horizontal overflow. |
| Long name/cue | Full wrapped heading at 402px; at 390px stage scroll made the entire 93px long cue visible inside its bounds. |
| Number pad and annotation | At 390px keys are 58px, Cancel/Set load 56px and inside the viewport. Saved annotation read back in the More sheet. No OS keyboard check. |
| Train/preview/Finish | Go/Close did not start a session, Start did; staged Finish RPE/note survived Back to Session. Final summary accurately showed one logged set and one of eight exercises. |
| Program/editor | Full long names, 44px actions; calendar cells measured 44px at 320, 50.28px at 360, 54.57px at 390 and 45.71px at 402. Wheel paging and Today return worked. Native pointer drag did not page, so touch acceptance remains open. |
| Record/shared sheets | Light cards preserve metric/provenance warnings. Check-in controls are at least 44px in a contained scroller. Settings sheet scrolls with reachable close/unit/inventory controls and returns focus on close. |

Final demo screenshots are in `/Users/coltbradley/.codex/visualizations/2026/10/01/01a0f5f9-4a5d-7ed0-b9d7-c8096fa0e8c6/`: `version-d-focus-final.jpg`, `version-d-list-final.jpg`, `version-d-finish-final.jpg`, `version-d-program-final.jpg`, `version-d-record-final.jpg`, `version-d-correction-note-final.jpg`. Focus and correction-note screenshots were refreshed at `125d203`. They are local preview evidence, not production records. The non-offline mock clears KV/outbox and reseeds on reload, so demo reload is not persistence proof.

## Acceptance and rollback

New-data phone touch, offline/update/reconnect, authenticated multi-account E2E, exact set/void UUID readback, served SHA/deployment receipt and human design acceptance are NOT RUN. These remain release checks. Existing release-ledger production rows were not closed by local evidence.

Revert the local branch changes or a later authorized PWA release without clearing device storage. No migration rollback is needed. Preserve unsynced data, storage names and stores.

Correction relationship ruling: retain one owner-stamped ACK witness per correction in the existing outbox, outside counts/replay/inspection/export. It preserves relation metadata across legitimate KV cache clearing; only fresh exact set/void evidence proves acceptance. Cost is one local metadata row per correction, with no compaction yet. Older code can replay the void idempotently and delete the witness; after KV clearing, that can lose the relation and make the replacement look like an ordinary Synced set. Rollback must not promise Review detection in that case.
