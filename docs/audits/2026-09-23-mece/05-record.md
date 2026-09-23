# Group 05: History, subjective capture, export, and feedback UI

## Scope and evidence

Inspected `pwa/src/screens/History.tsx`, `components/{BodyweightRow,CheckInSheet,CheckinWeek,SessionHistory,RateSessionCard,ReportBugSheet}.tsx`, `components/charts/{E1rmChart,VolumeChart}.tsx`, and `lib/{checkinHistory,checkinMemory,checkinWeek,checkins,e1rm,export,review,sessionHistory,prompts}.ts`, with adjacent tests. Read `AGENTS.md`, the active roadmap and release ledger, and rechecked the cited leads in `docs/audits/2026-09-19-system-audit.md`. Read-only checks: `rg` for prompt/report-prompt production callers and targeted `nl -ba` source/migration reads. No tests or live services were run.

## Executive summary

Confirmed findings: 6 (P1: 1, P2: 5). The largest risks are incomplete export semantics, prompt/response capture not connected to the production flow, and History surfaces that can disagree with queued or filtered records. The current check-in redesign and History check-in review are present; A-96 and A-97 are correctly listed as fixed with tests.

## Findings

### G05-F01. Standard exports omit captured set fields needed to interpret or restore a set

- **Severity:** P1. **Confidence:** high.
- **Trigger:** A user exports JSON or CSV after recording per-set RPE, time-tracked duration, or a per-side load.
- **Evidence:** `ExportSet` and `SET_COLUMNS` include neither `rpe` nor `duration_seconds` (`pwa/src/lib/export.ts:29-44,57-65`). `CSV_HEADER`/`toCsv` omit `load_entry`, `prescription_id`, `rpe`, and `duration_seconds` (`pwa/src/lib/export.ts:139-156,168-197`). The database stores these values (`pwa/src/lib/types.ts:216-238`; `supabase/migrations/20260906030000_tracking_time.sql:36-42`; `supabase/migrations/20260906010000_set_rpe.sql:20-44`). Settings describes JSON as “SESSIONS + SETS” and CSV as “ONE ROW PER SET” (`pwa/src/components/SettingsSheet.tsx:428-449`).
- **Impact:** CSV loses the distinction between per-side and total entry. Both formats discard set RPE and timed-set duration, so exported sets cannot fully preserve what was logged. These values cannot be reconstructed from the remaining fields.
- **Existing lead:** A-98 (open).
- **Fix boundary:** Extend the archive schema and both serializers with all persisted set semantics; define explicitly which related records the export promises.
- **Verification needed:** Round-trip fixtures covering per-side loads, RPE, duration, notes, null legacy values, and multiple pages; inspect downloaded JSON and CSV against those rows.

### G05-F02. Standalone bodyweight entries have no correction or removal path in the PWA

- **Severity:** P2. **Confidence:** high.
- **Trigger:** A user mistypes a standalone weigh-in and needs to correct or remove it.
- **Evidence:** The row offers only a new measurement (`pwa/src/components/BodyweightRow.tsx:91-100,162-184`); the client exposes `recordBodyweight` as an insert (`pwa/src/lib/data.ts:2000-2020`). The database intentionally permits owner update and delete on `bodyweight_log` (`supabase/migrations/20260906020000_bodyweight_log.sql:34-48`) and the union view exposes `source_id` for identifying the source row (`...sql:54-61`).
- **Impact:** An erroneous standalone measurement remains in the bodyweight series indefinitely from the user's available UI, and later measurements only supersede it as “latest” rather than correcting the historical point.
- **Existing lead:** A-185 (not in the current release ledger; reverified).
- **Fix boundary:** Add owner-scoped correction/removal UI for `source='log'`, retaining session-derived measurements as immutable session facts.
- **Verification needed:** Correct and remove a standalone point; verify `v_bodyweight` and cache readback, and verify a session-sourced point has no such action.

### G05-F03. The session log can return fewer than 20 valid rows while older finished sessions exist

- **Severity:** P2. **Confidence:** high.
- **Trigger:** At least one of the newest 20 server sessions has a discard queued locally.
- **Evidence:** `getSessionLog` applies `.limit(SESSION_LOG_LIMIT)` to the newest server rows before client-side filtering (`pwa/src/lib/sessionHistory.ts:199-216`). The returned cached or live list is filtered against pending discards afterward (`...sessionHistory.ts:269-271`).
- **Impact:** The pending discard consumes a slot, so an older valid session is not fetched and the visible History list contains fewer than 20 sessions. This can make the log look truncated while a correction is pending.
- **Existing lead:** A-182 (reverified; no longer only a cached-path concern).
- **Fix boundary:** Fetch enough rows after applying local pending-discard exclusions, or page until 20 visible sessions are collected.
- **Verification needed:** Seed more than 20 sessions, queue discard(s) among the newest, and assert the list fills from older valid rows online and offline.

### G05-F04. Session set counts silently stop counting at 2,000 rows

- **Severity:** P2. **Confidence:** high.
- **Trigger:** The latest 20 visible sessions collectively contain more than 2,000 live sets.
- **Evidence:** The query is capped at `SESSION_LOG_SET_CAP = 2000` (`pwa/src/lib/sessionHistory.ts:39-41`) and tallies only the returned rows without checking for truncation or paging (`...sessionHistory.ts:243-253`).
- **Impact:** Counts on one or more session rows are understated, with no indication that the count is partial.
- **Existing lead:** A-111 (reverified).
- **Fix boundary:** Page the count read or return an explicit incomplete-count state instead of presenting a partial count as exact.
- **Verification needed:** More than 2,000 sets across the displayed sessions, including a boundary split; compare each displayed count with an uncapped database count.

### G05-F05. Check-in detail and energy grid disagree while check-ins are queued offline

- **Severity:** P2. **Confidence:** high.
- **Trigger:** A check-in is queued offline, or remains queued after a failed sync, and the user opens History.
- **Evidence:** `CheckinWeek` merges queued check-ins into the detail/day-count collection (`pwa/src/components/CheckinWeek.tsx:54-63,79-81`), while the energy grid is built only from `getWeekBuckets` data (`...CheckinWeek.tsx:75-77`). `getWeekBuckets` reads the server view and has no pending-outbox merge (`pwa/src/lib/checkinHistory.ts:83-100`).
- **Impact:** The selected date can show a check-in and its count while the energy cell says there were no check-ins or omits the new energy score. Offline History presents two competing summaries of the same week.
- **Existing lead:** New finding.
- **Fix boundary:** Derive the local grid from the merged rows or merge pending check-ins into bucket counts and means using the same bucket definition.
- **Verification needed:** Queue check-ins with and without energy in each time bucket; assert grid, count, and selected-day details agree online, offline, and after replay.

### G05-F06. Subjective prompt scheduling and response records have no production caller

- **Severity:** P2. **Confidence:** high.
- **Trigger:** A user expects the configured weekly or next-morning prompt flow to run.
- **Evidence:** Production callers of `duePrompts`/`overduePrompts` and writes to `report_prompts` are absent: the only non-test matches are the pure functions in `pwa/src/lib/prompts.ts:88-163`, a comment in `pwa/src/lib/push.ts:344`, and the outbox type in `pwa/src/lib/db.ts:84-88`. Current `CheckInSheet` creates a spontaneous `checkins` row through `buildCheckinOps` (`pwa/src/components/CheckInSheet.tsx:147-165`; `pwa/src/lib/checkins.ts:171-215`) and has no prompt ID or `report_prompts` update. The migration defines `responded_at`/`skipped` on `report_prompts` (`supabase/migrations/20260907040000_subjective_capture.sql:382-401`).
- **Impact:** The pure schedule logic does not arm or show prompts, and there are no prompt denominator rows or response timestamps for production answers. The app cannot measure prompted-versus-answered behavior or satisfy a real next-morning prompt gate from this path.
- **Existing lead:** A-94 and A-95 (both open in the release ledger; verified against current callers).
- **Fix boundary:** Connect scheduling/delivery, durable prompt creation, and answer/skip linkage as one flow. Coordinate the row contract with group 01 and the push scheduler/operational path with groups 11/13.
- **Verification needed:** End-to-end test for due prompt creation, offline answer/skip, replay, response timestamp, and no duplicate or stale prompt; then real-device next-morning acceptance and live scheduler proof where applicable.

## Opportunities

- **G05-O01. Offer a clearly named complete account archive.** Current export says sessions and sets; it omits plans and other records by design. A versioned archive could support recovery or migration, but requires restore mapping and preservation decisions for soft-deleted and voided facts. Justify investment with a concrete portability/restore requirement, then define its contract before implementation.

## Documentation gaps

- `pwa/src/lib/export.ts:1-11` calls this “the whole training record,” while the Settings labels narrow it to sessions and sets. State the narrower contract in code comments and document exactly which set fields and queued writes are included. Even under that narrower contract, G05-F01 shows fields are missing.
- `pwa/src/lib/prompts.ts:1-9` describes a future scheduler/foreground caller, and `pwa/src/lib/push.ts:344` refers to foreground use, but current production code has no caller. Keep that distinction explicit wherever subjective prompting is called shipped; the active roadmap requires a real next-morning prompt only as a later acceptance gate.

## Handoffs

- **Group 02, PWA platform:** A successful bodyweight outbox enqueue can be followed by a failed cache refresh (`pwa/src/lib/data.ts:1987-2020`); `BodyweightRow.tsx:91-100` then reports failure, and retry can queue a second UUID. The primary fix belongs in the shared data layer; this is G02-F15.
- **Group 02, PWA platform:** History's exercise index (`pwa/src/lib/data.ts:1361-1385`), charts/recent sets (`...data.ts:1760-1785,1923-1935`), and expanded session sets (`pwa/src/screens/History.tsx:233-249`) read server/cache data and only subtract queued voids/discards; they do not merge `outbox.pendingSets()`. After logging offline and leaving the session, History may omit the exercise and its sets until replay. Primary fix crosses shared data transport/cache behavior; recheck pending notes and cache write failure paths there too. This revalidates A-112/A-113 leads.
- **Group 01, database:** `v_weekly_summary` counts working sets/tonnage from `v_live_sets` but counts only sessions with `ended_at` (`supabase/migrations/20260906040000_v_weekly_summary.sql:19-39`). Since `v_live_sets` includes sets from open sessions, an active workout can contribute weekly work while the session count remains zero. Review/fix at the view boundary; this is A-184.
- **Group 01, database:** `v_checkin_buckets` groups timestamps using `app_tz(user_id)` (`supabase/migrations/20260916000000_checkin_redesign.sql:45-50,55-74`), while `CheckinWeek` builds dates from the device-local clock and `getWeekCheckins` queries device-local instant bounds (`pwa/src/lib/checkinHistory.ts:26-35,55-72`). If configured `app_tz` differs from the current device timezone, the grid and detail list can bucket the same check-in onto different dates. Confirm intended timezone authority and align the view/client contract.

## Open questions and limits

- No production database, browser, phone, scheduler, or deployment behavior was exercised. Prompt/scheduler and timezone observations are source-level only.
- The roadmap says check-in, skip, and coach-observation paths need live acceptance, while the prompt engine is not part of the current foreground flow. Product ownership should confirm whether the weekly/next-morning prompt path is intentionally deferred until its later gate or is currently promised elsewhere.
- Existing check-in tests cover the merged History/detail behavior and redesign, but this audit did not run them; no local tests were run per audit scope.
