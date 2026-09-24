# Group 10: In-app coach backend and client

## Scope and evidence

Inspected `supabase/functions/coach/**`, `scripts/coach-eval/**`, `pwa/src/components/{CoachSheet,Markdown}.tsx`, `pwa/src/lib/{coach,coachAccess,coachContext,coachOpen,markdown}*.ts`, and adjacent coach tests. Read `AGENTS.md`, the audit README, active roadmap, release ledger, and relevant sections of the 2026-09-19 audit. Followed quota reservation into `20260921010000_reserve_coach_turn.sql` and checked coach usage schema/policies.

Read-only checks: `rg --files ...`, targeted `rg -n`, `nl -ba`/`sed` source reads, and `git status --short`. No tests, live services, secrets, browser, or device were used.

## Executive summary

Confirmed findings: 1 P1, 9 P2. Top risks are indefinite server retention of health-related coach context, lost or misapplied streamed answers during recovery, and failure paths that escape the daily spend/message accounting. The code now rejects unset allowlists, ignores fabricated client assistant turns, JSON-wraps context and uploads as untrusted data, and structurally disables several dangerous connector tools. Production allowlist configuration remains `needs live proof` per A-02; this static audit cannot settle it.

## Findings

### G10-F01. Coach logs retain sensitive conversation content indefinitely

- **Severity:** P1. **Confidence:** High.
- **Trigger:** Any successful coach turn while `COACH_LOG_CONTENT` is unset or not exactly `off`.
- **Evidence:** `record` defaults content logging to on and stores the latest user text and complete answer in `coach_usage` ([supabase/functions/coach/index.ts:543-544](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:567-582](../../../supabase/functions/coach/index.ts)). That user text includes the PWA's serialized current context, which may contain symptom/injury state, memory, session notes, and current training data ([pwa/src/lib/coach.ts:76-87](../../../pwa/src/lib/coach.ts), [pwa/src/lib/coachContext.ts:545-575](../../../pwa/src/lib/coachContext.ts), [pwa/src/lib/coachContext.ts:596-652](../../../pwa/src/lib/coachContext.ts)). The schema makes the content readable to the deployment operator but defines no expiry ([supabase/migrations/20260831050000_coach_observability.sql:16-36](../../../supabase/migrations/20260831050000_coach_observability.sql)); no coach-content retention or deletion job was found.
- **Impact:** A deployment operator can read durable private conversation and health/training context after it is no longer needed. The opt-out requires deployment configuration and does not remove historical rows.
- **Existing audit/ledger:** A-154, still relevant; ledger does not track it as a closed item.
- **Suggested fix boundary:** Coach privacy/retention policy and operator-facing consent/configuration; keep quota/operational counters while expiring or removing text on a stated schedule.
- **Verification needed:** Inspect effective production `COACH_LOG_CONTENT` without exposing its value; verify a documented retention interval, deletion behavior, and that cost accounting still works with text fields null.

### G10-F02. Recovery can overwrite a newly sent question

- **Severity:** P2. **Confidence:** High.
- **Trigger:** The sheet opens with a persisted streaming placeholder; the recovery read is still pending and the user sends another message.
- **Evidence:** The mount-only recovery effect does not set `busy` while `recoverAnswer` is pending ([pwa/src/components/CoachSheet.tsx:143-172](../../../pwa/src/components/CoachSheet.tsx)). Sending is therefore allowed, and recovery later maps the *current last message* rather than the placeholder for its `turnId` ([pwa/src/components/CoachSheet.tsx:147-165](../../../pwa/src/components/CoachSheet.tsx), [pwa/src/components/CoachSheet.tsx:210-236](../../../pwa/src/components/CoachSheet.tsx)).
- **Impact:** The older recovered answer can replace the new assistant placeholder, attaching the wrong answer to the new question.
- **Existing audit/ledger:** A-10.
- **Suggested fix boundary:** PWA coach recovery state; update the message matching the recovered turn ID and prevent a new send until recovery resolves, or recover in parallel without sharing the last-message target.
- **Verification needed:** Component test with delayed recovery, a send before resolution, then assert both questions retain their own assistant turns.

### G10-F03. Stopping a response discards its recoverable remainder

- **Severity:** P2. **Confidence:** High.
- **Trigger:** User presses Stop after receiving only part of the response; server subsequently completes and persists the full answer.
- **Evidence:** Stop aborts the reader and immediately marks the last assistant message non-streaming ([pwa/src/components/CoachSheet.tsx:309-328](../../../pwa/src/components/CoachSheet.tsx)). Recovery runs only for a last message still marked streaming ([pwa/src/components/CoachSheet.tsx:143-165](../../../pwa/src/components/CoachSheet.tsx)); persisted full responses are available through `recoverAnswer` ([pwa/src/lib/coach.ts:214-231](../../../pwa/src/lib/coach.ts)).
- **Impact:** The local transcript remains truncated even though the server may have the complete answer; there is no explicit fetch-full-answer action.
- **Existing audit/ledger:** A-175.
- **Suggested fix boundary:** PWA coach stop/recovery behavior; preserve the turn ID as recoverable after Stop and distinguish “stop listening” from “discard this answer.”
- **Verification needed:** Integration/component test that stops midstream, completes server persistence, reopens the sheet, and confirms full-answer recovery or a visible choice.

### G10-F04. Clean EOF without a `done` event leaves the coach busy

- **Severity:** P2. **Confidence:** High.
- **Trigger:** The response body ends cleanly before the client receives an explicit `done` event.
- **Evidence:** `askCoach` calls `onDone` only when it parses the `done` event; EOF simply exits the read loop ([pwa/src/lib/coach.ts:142-178](../../../pwa/src/lib/coach.ts)). The sheet clears `busy` only from completion or error callbacks ([pwa/src/components/CoachSheet.tsx:257-279](../../../pwa/src/components/CoachSheet.tsx)).
- **Impact:** The placeholder can remain streaming and the compose controls stay in Stop state until the sheet is reopened or discarded.
- **Existing audit/ledger:** A-168.
- **Suggested fix boundary:** PWA SSE terminal-state handling, with a recoverable interrupted state on EOF lacking `done`.
- **Verification needed:** Client test for clean EOF with partial text and no terminal event; assert a finite, retryable/recoverable UI state.

### G10-F05. Failed generations do not consume the daily turn allowance

- **Severity:** P2. **Confidence:** High.
- **Trigger:** Anthropic/MCP generation throws after quota reservation.
- **Evidence:** The catch stores the upstream exception in `failed` ([supabase/functions/coach/index.ts:1214-1226](../../../supabase/functions/coach/index.ts)); `record` writes it to `refused` ([supabase/functions/coach/index.ts:567-582](../../../supabase/functions/coach/index.ts)). The atomic reservation counts only rows with `refused is null` ([supabase/migrations/20260921010000_reserve_coach_turn.sql:20-25](../../../supabase/migrations/20260921010000_reserve_coach_turn.sql)). Also, usage remains zero unless `finalMessage()` succeeds ([supabase/functions/coach/index.ts:1205-1212](../../../supabase/functions/coach/index.ts)).
- **Impact:** Repeated failed requests bypass the daily turn cap; any provider-billed partial work before the failure is also absent from recorded token usage.
- **Existing audit/ledger:** A-19. Atomic reservation A-07 is marked fixed with test, but this post-reservation failure classification remains.
- **Suggested fix boundary:** Coach settlement must distinguish an admission refusal from a generation failure and preserve/count a failed reserved turn; coordinate reservation row semantics with group 01 (SQL).
- **Verification needed:** Inject failures before and during streamed output; prove daily counts include admitted attempts and partial provider usage is recorded when available.

### G10-F06. The check-in-memory route can exceed the monthly cap under concurrent extraction calls

- **Severity:** P2. **Confidence:** Medium.
- **Trigger:** Concurrent authenticated `/checkin-memory` requests begin below the monthly threshold and process different claimed note batches.
- **Evidence:** The route checks accumulated usage with `monthlySpentTokens` then starts up to three separate extraction batches without inserting a reservation first ([supabase/functions/coach/index.ts:303-327](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:670-687](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:697-703](../../../supabase/functions/coach/index.ts)). Extraction usage is inserted only after the model call and fact writes ([supabase/functions/coach/memory-extract.ts:1052-1059](../../../supabase/functions/coach/memory-extract.ts), [supabase/functions/coach/memory-extract.ts:1093-1115](../../../supabase/functions/coach/memory-extract.ts)).
- **Impact:** Multiple devices or direct requests can all pass the stale spend check and incur provider cost beyond the configured monthly ceiling. The note claims prevent duplicate processing of the same rows, but do not serialize distinct batches against the shared budget.
- **Existing audit/ledger:** Related quota lead A-07; the current turn reservation does not cover this route.
- **Suggested fix boundary:** Coach extraction reservation/settlement; coordinate any shared atomic budget primitive with group 01.
- **Verification needed:** Concurrent requests with different eligible notes near the threshold; assert only reserved budget is admitted and settled usage is counted once.

### G10-F07. A worker exit after a memory claim strands that source note permanently

- **Severity:** P2. **Confidence:** High.
- **Trigger:** The edge worker stops after stamping `memory_extracted_at` but before extraction/cleanup completes.
- **Evidence:** The check-in, set-note, and session-note paths stamp a claim before calling extraction ([supabase/functions/coach/index.ts:724-747](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:787-810](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:857-880](../../../supabase/functions/coach/index.ts)). Cleanup resets claims only in an in-process catch; claim timestamps have no expiry/lease check in these paths. The route selects only rows where the claim is null ([supabase/functions/coach/index.ts:708-716](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:775-782](../../../supabase/functions/coach/index.ts), [supabase/functions/coach/index.ts:841-849](../../../supabase/functions/coach/index.ts)).
- **Impact:** The note may never contribute a standing injury, equipment constraint, or preference to future coaching.
- **Existing audit/ledger:** A-17.
- **Suggested fix boundary:** Coach extraction claim lifecycle; use an expiring lease or recover stale claims.
- **Verification needed:** Simulate worker loss after claim and verify a later run reclaims and processes the note without duplicating facts.

### G10-F08. Coach context treats a failed standing-memory read as no known constraints

- **Severity:** P2. **Confidence:** High.
- **Trigger:** PostgREST returns an error for the `coach_memory` query without throwing a transport exception.
- **Evidence:** `standingFacts` destructures only `data`, ignores `error`, and returns an empty array ([pwa/src/lib/coachContext.ts:284-293](../../../pwa/src/lib/coachContext.ts)). `buildCoachContext` then omits the entire memory section when that array is empty ([pwa/src/lib/coachContext.ts:528-536](../../../pwa/src/lib/coachContext.ts)).
- **Impact:** The model is not told that context is incomplete and may recommend around an injury or constraint it has previously been told about.
- **Existing audit/ledger:** A-81.
- **Suggested fix boundary:** PWA coach context read/error reporting; represent unavailable separately from genuinely empty memory.
- **Verification needed:** Mock a returned query error and prove the context explicitly says memory could not be read and reports the failure.

### G10-F09. Retried attachments after reload contain no file bytes

- **Severity:** P2. **Confidence:** High.
- **Trigger:** User reloads while a message with attachments is saved, then uses Ask again.
- **Evidence:** Local persistence deliberately stores attachment metadata with `data: ""` ([pwa/src/components/CoachSheet.tsx:65-80](../../../pwa/src/components/CoachSheet.tsx)). Retry restores those persisted attachment objects and resends them ([pwa/src/components/CoachSheet.tsx:330-345](../../../pwa/src/components/CoachSheet.tsx)).
- **Impact:** The retried request is missing the original image/PDF/text contents and can fail or produce a different answer while showing the file name as attached.
- **Existing audit/ledger:** A-169.
- **Suggested fix boundary:** PWA retry UX; require reattachment or state clearly that the attachment bytes were not retained.
- **Verification needed:** Reload, retry an attachment turn, and verify the UI requires the original file or sends byte-identical content.

### G10-F10. Coach streaming state and errors are not announced to screen readers

- **Severity:** P2. **Confidence:** High.
- **Trigger:** A screen-reader user submits a question while text, thinking, tool status, or an error appears.
- **Evidence:** Conversation messages and status strings render in ordinary `div` elements with no live-region or status semantics ([pwa/src/components/CoachSheet.tsx:403-455](../../../pwa/src/components/CoachSheet.tsx)); no corresponding `aria-live` or `role=status` appears in the component.
- **Impact:** Screen-reader users are not automatically notified of the streamed response or whether the coach is thinking, using a tool, or has failed.
- **Existing audit/ledger:** A-124.
- **Suggested fix boundary:** CoachSheet accessible status and message announcements, avoiding repeated announcement of every token.
- **Verification needed:** Accessibility test or screen-reader acceptance for submission, completion, tool wait, and error states.

## Opportunities

### G10-O01. Make the coach tool surface an explicit positive allowlist

The connector currently disables named tools but otherwise exposes the MCP server's full toolset ([supabase/functions/coach/index.ts:1139-1177](../../../supabase/functions/coach/index.ts)). A future MCP tool is therefore coach-accessible by default until someone remembers to add a denial. An explicit reviewed allowlist would make new tool exposure opt-in. Cost is modest code/config maintenance when a coach capability is intentionally added; evidence for investment is a tool inventory and a change test proving an unlisted newly registered tool is unavailable.

### G10-O02. Validate eval transcript export identifiers before SQL construction

`fetch-turns.mjs` interpolates `--user` directly into SQL ([scripts/coach-eval/fetch-turns.mjs:24-36](../../../scripts/coach-eval/fetch-turns.mjs)). This is a local operator tool, and its README says to ask the person before extracting a real transcript, so this is not a web-facing path. Still, malformed or shell-sourced identifiers can change the query and export more private transcripts than intended. UUID validation has negligible cost; verify malformed input is refused before invoking the Supabase CLI.

## Documentation gaps

- `scripts/coach-eval/README.md` says transcript export requires asking the person first ([scripts/coach-eval/README.md:79-87](../../../scripts/coach-eval/README.md)), but `fetch-turns.mjs` only requires a `--user` string and has no confirmation or UUID validation ([scripts/coach-eval/fetch-turns.mjs:24-36](../../../scripts/coach-eval/fetch-turns.mjs)). Desired claim: the script accepts only a UUID and the operator must have obtained consent before running it.
- The release ledger records A-02 as `needs live proof`; code evidence that an unset variable returns 503 does not prove the production secret currently contains only the intended user UUID ([docs/roadmaps/release-ledger.md:16-18](../../../docs/roadmaps/release-ledger.md), [docs/roadmaps/2026-09-19-consolidated-roadmap.md:7-15](../../../docs/roadmaps/2026-09-19-consolidated-roadmap.md)). No live secret inspection was performed.

## Handoffs

- **Group 01:** G10-F05 and G10-F06 depend on quota row semantics/atomic budget accounting in `supabase/migrations/20260921010000_reserve_coach_turn.sql`; coach generation and extraction settlement behavior is evidenced here.
- **Group 05:** Check-in memory requests in `pwa/src/lib/checkinMemory.ts:19-61` discard non-2xx responses without a retry. The primary client fix is recorded as G05-F07; the server must expose a recoverable outcome.
- **Group 07:** None. Authentication and MCP gateway ownership was not re-audited beyond the coach's use of the existing Supabase session and MCP connector.

## Open questions and limits

- Is production `COACH_ALLOWED_USERS` set to only the intended in-app-coach user? A-02 remains `needs live proof`; this audit did not inspect secrets or contact Supabase.
- Do provider failures after partial generation incur billable tokens, and does the SDK expose that partial usage? Static code records zeros on exceptions; provider billing was not checked.
- This is static source evidence, not proof of deployed Edge Function behavior, production retention settings, or browser/screen-reader behavior.
