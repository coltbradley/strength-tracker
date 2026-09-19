# Live session adaptation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app records what actually happened in a session, as the lifter names it, and the coach adapts to it: set type and skips chosen at log time, equipment-aware load entry with correct plate math, a clear focus/overview model with light motion, calmer sync, and coach trends and observations that don't get recomputed or forgotten.

**Architecture:** PWA changes stay in the existing session screen, device-local settings and outbox. Four additive migrations add `session_skips`, `coach_observations` with `v_trend_digest`, note-memory stamps and six FK indexes. New read and write MCP tools follow the `get_checkins` pattern and `lib/testing.ts`. The per-turn context block in `pwa/src/lib/coachContext.ts` gains TRENDS and OBSERVATIONS lines.

**Tech stack:** React + Vite PWA (TypeScript strict, Vitest, Testing Library), Supabase Postgres (validated in PGlite by `scripts/validate-db.mjs`), Deno edge functions (MCP server and coach), plain CSS tokens.

**Spec:** `docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md`. Where this plan and the spec disagree, the task text wins only where its "Deviations" note says why; otherwise the spec wins.

## Global constraints

- Base: `main` including PR 2 (`checkin-redesign`, migration `20260916000000`). New migrations are `20260917000000` to `20260917030000`, in that order.
- `load_kg` is always total system load. No `base_kg` column. Base or bar weight is device-local `ExercisePref.barKg`, used only by the plate calculator.
- `sets` is append-only. A correction is a void plus a new row at the same `set_index` (`pwa/src/lib/corrections.ts`). `session_skips` has no update or delete policy.
- Every queued write carries a client UUID and the user id, and replays with `on conflict do nothing`. A bulk row builder emits every column on every row.
- No adherence percentage, composite score or body-image rating anywhere. Every mean ships with its count.
- Derived metrics live in views only. `coach_observations.evidence` is a frozen record and is never read as a metric.
- Colours only via tokens in `pwa/src/styles.css`. The accent is never body copy. Tap targets at least 44px. Motion animates `transform` and `opacity` only, and is zeroed by the existing reduced-motion block.
- No new runtime dependencies. No CDN.
- Project rules live in `AGENTS.md` (`CLAUDE.md` imports it). Read it before any task.

## Rules for every implementer

- Touch only the files your task lists. If another file needs a change, stop and report it.
- An editor hook reformats files written with the Edit or Write tools. Prefer shell edits for existing files and check `git diff -w` before committing. Code blocks in this plan may have lost indentation for the same reason; the tests are the source of truth, not the whitespace.
- Where a later task quotes code an earlier task changed, locate it by the function name and anchor text given, not by line number.
- `git add` explicit paths only. Never push, never apply a migration to production, never resolve Sentry or feedback items.
- Before reporting done, run the task's commands and paste the pass/fail lines. `tsc --noEmit` is a no-op in this repo; `npm run build` is the type check.

## Execution guide

One task is one subagent with a fresh context, given only its task section, the Global constraints and the Rules above. Parallel tasks run in separate git worktrees cut from the current integration branch and merge back in the order listed. The reviewing session reads each diff against `AGENTS.md` hard rules before merging it.

Task text lives in `docs/superpowers/plans/2026-09-16-live-session-adaptation/`, one file per code area: `tasks-01-02-03-10.md` (load modes), `tasks-04-06-11.md` (SQL and MCP), `tasks-05-12-13-14.md` (sync, Today, header, weigh-in), `tasks-07-08-09.md` (session capture), `tasks-15-16-17-18.md` (clarity and motion), `tasks-19-20-21-22.md` (coach, memory, docs). Give an implementer this file plus its task section.

| Task | Name | Wave | Model | Depends on | Parallel with |
| --- | --- | --- | --- | --- | --- |
| 1 | Plate math | 1 | Haiku | none | 2-6 |
| 2 | Load-mode logic | 1 | Sonnet | none | 1, 3-6 |
| 3 | Load icons and motion tokens | 1 | Haiku | none | 1, 2, 4-6 |
| 4 | Migrations | 1 | Sonnet | none | 1-3, 5, 6 |
| 5 | Sync noise, reports through the outbox | 1 | Sonnet | none | 1-4, 6 |
| 6 | MCP reads: get_bodyweight, custom-exercise instructions | 1 | Sonnet | none | 1-5 |
| 7 | Tap lock | 2 | Sonnet | 1, 3 | 11, 12, 13 |
| 8 | Set type on hero, Already warm, fix last set, swap and skip | 2 | Sonnet | 7 | 11, 12, 13 |
| 9 | session_skips written at Finish | 2 | Sonnet | 4, 5, 8, 12 | 11, 13 |
| 10 | Load-mode UI | 2 | Sonnet | 2, 3, 9 | 11, 13 |
| 11 | MCP: trends, observations, session diff, skips | 2 | Sonnet | 4, 6 | 7-10, 12, 13 |
| 12 | Today done state | 2 | Sonnet | none (merge before 9) | 7, 8, 11, 13 |
| 13 | Header | 2 | Haiku | none | 7-12 |
| 14 | History Log weight line | 3 | Sonnet | none | 15-20 |
| 15 | StateGlyph and progress rail | 3 | Sonnet | 10 | 14, 19, 20 |
| 16 | Rest looks forward, RPE chips | 3 | Sonnet | 15 | 14, 19, 20, 21 |
| 17 | Motion | 3 | Sonnet | 3, 16 | 14, 19, 20, 21 |
| 18 | Focus extras: How to | 3 | Haiku | 17 | 19, 20, 21 |
| 19 | Coach prompt and context TRENDS/OBSERVATIONS | 3 | Sonnet | 11 | 14-18, 20, 21 |
| 20 | Set and session notes into memory | 3 | Sonnet | 4 | 14-19, 21 |
| 21 | Observations in History | 3 | Haiku | 11, 14 | 15-20 |
| 22 | Docs and full verification | 4 | Sonnet | all | none |

Serial chains, because they share files: 7 → 8 → 9 → 10 → 15 → 16 → 17 → 18 (`Session.tsx`, session components, `styles.css`); 5 → 9 (both widen the outbox table union in `lib/outbox.ts`); 12 → 9 (both edit `screens/End.tsx`); 14 → 21 (`History.tsx`). Tasks that append to `styles.css` in the same wave merge one at a time and resolve by keeping both rules.

## Reviewer amendments already applied

- Task 12 waits on `outbox.flush()` for at most 1.5 s, so Finish never hangs on bad gym wifi.
- Task 17's mode switch is focus to overview, animated on the root that mounts. Nothing is keyed to force a remount, because remounting the hero editor discards typed input.

## Known deviations from the spec, decided while drafting

- Task 5 needs no feedback migration: a client UUID overrides `feedback.id`'s default. `lib/sync.ts` and `ReportBugSheet.tsx` need no change.
- Task 7: pad rounding already matches the widened plate tolerance, so only the lock changes. It also covers `SupersetRoundEditor.tsx`.
- Task 9: the table union lives in `OutboxTransport.insert` in `lib/outbox.ts`, not in `lib/sync.ts`.
- Task 10: superset rounds get the plates/stack correctness fix but not the icon toggle.
- Task 11: `get_session_diff` reads `prescriptions`, `v_live_sets` and `v_adherence`, because `v_adherence` excludes warmups. `v_trend_digest` returns no row for a user with no data.
- Task 12: the real bug is Today's online-first read racing Finish's un-awaited write, not `doneTick`. The done card shows set count and duration; working volume is left out rather than recomputing `v_weekly_volume` in the client.
- Task 13: the "two menus" look is one CSS override on `.header-action-coach`; `App.tsx` doesn't change.
- Task 14 reuses the existing `BodyweightRow` from PR 2.
- Task 15: tapping the current entry's dot opens the overview.
- Task 18: set notes and collapsible coach notes already exist in focus mode; only How to is new.
- Task 20: the check-in memory route sweeps check-ins, set notes and session notes independently, so one source failing doesn't block the others.
- Task 22 writes hard-rule bullets into `AGENTS.md`.

