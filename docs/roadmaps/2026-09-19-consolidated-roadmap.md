# Consolidated roadmap, 2026-09-19

## Current status (2026-09-24)

Reconciled against `main` at `4da2c7d` and the live Supabase project on
2026-09-24. Status per finding lives in `release-ledger.md`.

**Phase 0 and Phase 1 code are merged and deployed.** Slices 1 and 2 landed
through PR #10 (2026-09-21) and PR #12 (2026-09-24). Remote migrations match
local through `20260924052445`. MCP `/health` answers ok.

**Phase 2 started before Phase 1's gate closed, and that is accepted.** PR #12
also carried atomic, locked plan writes, permanent plan locks once a session
references a day, late-set session restore, and durable-first set logging
(see `docs/decisions.md`, 2026-09-24). A-92 and A-107 are closed with tests.

**Phase 1 exit gate is still open** on production evidence, not code:

- **A-02:** `COACH_ALLOWED_USERS` is not set, so the fail-closed coach answers
  503 for everyone, including its one intended user.
- **A-137/A-138: deferred to Phase 5 (Colt, 2026-09-24).** No `SWEEP_SECRET`,
  so the prompt sweep delivers nothing while the app is closed. That is
  acceptable for now: the daily prompt ships switched off, rest alerts do not
  use the sweep, and the app still asks in-app on foreground. They stay
  `needs live proof` on the ledger but no longer block Phase 1's gate.
- **A-135:** the deploy receipt prints the intended SHA but does not read it
  back from the served app (MECE G13-F02).
- **A-134:** deploy still ships past a red CI run by policy. The one CI
  failure at `4da2c7d` was a test race (Start clicked before it was enabled),
  fixed in the test on 2026-09-24.

**Next:** close the Phase 1 items above, then finish Phase 2 (A-91, A-84 and
the rest of its list, plus the seeded browser E2E suite and a phone run).

Audit inputs since this roadmap was written: the 2026-09-23 MECE audit
(`docs/audits/2026-09-23-mece/SUMMARY.md`) and the training-scenes UX review
(`docs/audits/2026-09-23-training-scenes-ux-and-reconciliation.md`). Both are
evidence backlogs like the 2026-09-19 audit.

**Also shipped outside phase order:** M-01 `update_memory` is on `main`
(`3cc8159`) and MCP has redeployed since. Close the feedback row once the
athlete accepts the outcome.

## Plan authority

This is the one active product and release roadmap. Follow its phases in
order. It supersedes every older "what is next" list in this repository.

| Document                                                       | Status now                 | How to use it                                                                                                                           |
| -------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| This roadmap                                                   | **Active**                 | The current product boundary, phase order, release gates, and beta model.                                                               |
| `docs/audits/2026-09-19-system-audit.md`                       | Evidence backlog           | Look up finding IDs and re-verify evidence. Do not execute its 209 findings as a flat plan.                                             |
| `docs/plan.md`                                                 | Historical build log       | Useful for what shipped and why, but its "What's left" list is superseded.                                                              |
| `docs/superpowers/plans/`                                      | Historical scoped plans    | Reuse a plan's evidence or design only after checking it against this roadmap and current code. Never resume unchecked tasks wholesale. |
| `AGENTS.md` and `docs/decisions.md`                            | Current constraints        | They remain binding. Historical specs are supporting design references only when consistent with them and this roadmap.                 |
| `docs/endurance-plan.md` and the endurance implementation spec | Deferred product reference | Use only in Phase 5. They do not authorize endurance product work before then.                                                          |

Before starting code in any phase, write one small implementation plan for
that failure boundary, with exact files, tests, live proof, and rollback. Do
not turn this roadmap into one giant patch or treat an old unchecked task as
automatically current.

## Decision

For the next release cycle, Strength Tracker is a trustworthy strength log for
private lifters who are also endurance athletes. Do not add activation,
endurance-planning, or scale features until the release and training-record
gates below pass.

The PWA is the phone-first capture and plan-read surface. MCP is the primary
planning and review surface. The in-app coach is a bounded fallback for a
private lifter who cannot use MCP, not the main distribution or monetisation
path. Neither coaching surface may silently write logged sets or rewrite a
confirmed plan.

The first beta is a small, named group of three to five friends, chosen for
ease rather than deliberate device coverage. It is not a coaching product or a
collaboration test. Each athlete chooses Claude or ChatGPT immediately and uses
their own MCP client for planning and review. The in-app coach is enabled only
for Colt's wife; every other beta participant uses the PWA plus MCP. Colt
provisions the accounts, then athletes use the product normally; there is no
scripted onboarding qualification beyond a real request succeeding.

The beta does not have a numeric activation or exit target. Colt expands,
pauses, or ends it on observed usefulness and friction: if it works, it works.
The beta-ready safety bar is deliberately narrower than full public launch but
not optional: sign in, plan, offline logging, safe finish, truthful review, and
a release that has direct production readback.

For plan creation, an unambiguous natural-language instruction such as "make
the plan and approve it" is valid approval in the same MCP conversation. A
separate confirmation is required only when approval is absent or ambiguous;
the system must not add ritual after the athlete has already made the decision.

The system audit is an evidence backlog, not a current release verdict. It was
committed at `4a854c2`; `main` subsequently merged the live-session adaptation
work at `eb17a1c`. The merge added the check-in redesign, session-skip history,
and coach-observation loop. Any finding these changes may affect is
**needs re-verification**, not automatically fixed.

## Verified starting point

| Area                       | Current evidence                                                                                                                                                    | What it does not prove                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Local engineering baseline | PWA: 81 test files / 934 tests, typecheck, and production build passed on 2026-09-19. Relay tests, database validation, and selected-column validation also passed. | A phone, browser, managed Supabase, or provider workflow.                |
| GitHub CI                  | CI run 35477247194 passed for `eb17a1c`.                                                                                                                            | A deployment or production behavior.                                     |
| Deployed database          | Remote migration history matches local through `20260917030000_fk_indexes`.                                                                                         | That each product path uses the migration correctly.                     |
| Edge Functions             | `mcp-server` v43, `coach` v18, `push-alerts` v6, and `endurance-sync` v3 are active.                                                                                | That a particular source SHA or a real provider/phone transaction works. |
| PWA publishing             | Deploy run 35166323767 published the PWA for `c391a54`. Its Supabase job was skipped.                                                                               | Schema/function parity, or a post-deploy smoke test.                     |

The current production build still has one 766.82 kB minified entry bundle
(229.09 kB gzip). That is a measured maintenance concern, not the next release
blocker.

## What is actually in the pipeline

The repository has useful local and CI checks: PGlite migrations/views/RLS,
selected-column validation, tunnel-relay tests, MCP/coach/push/endurance Deno
checks, and PWA build/tests. It does not yet have a release pipeline in the
strong sense.

- CI and deploy are separate push workflows, so a failing CI run can still
  deploy.
- A PWA publish proceeds when the Supabase job is skipped. The latest inspected
  deploy demonstrates that exact path.
- PWA environment values are not validated before build.
- There is no seeded browser E2E suite, deployed-function smoke test,
  migration/function/PWA release manifest, rollback verification, or recovery
  drill.

Treat a green build as a code-quality signal. Treat a release as successful
only after the release gates below have direct readback.

## Priority rules

1. A fix that can lose, misattribute, hide, or disclose the training record
   outranks a feature.
2. A finding is closed only with a regression test and the correct evidence
   layer: PGlite/RLS test for database rules, browser test for client behavior,
   deployed smoke for a release boundary, and phone acceptance for the workout
   loop.
3. Keep one release candidate small. Do not mix migrations, coach behavior,
   push, and a new product capability unless the dependency is unavoidable.
4. The audit's 209 findings must be grouped by failure boundary. Do not run a
   209-ticket implementation programme.
5. Missing endurance context is UNKNOWN, never zero. Until an endurance
   integration is trusted, MCP must say what it does not know before making a
   combined-training recommendation.

## Feedback intake, 2026-09-20

`public.feedback` is the live intake queue. An unresolved request means the
athlete has not yet accepted its outcome; it is not evidence that the capability
is absent. Re-check current code before scheduling work, and leave a feedback
row open until the athlete says the outcome is acceptable.

| Live request                                                   | Roadmap disposition                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit or delete standing memories                               | **Shipped on `main` (`3cc8159`, M-01).** Owner-scoped `update_memory` is in the MCP server with tests; `forget` remains the permanent-delete action. Keep the feedback row open until the next MCP deploy and the athlete accepts the outcome. Does not authorize adjacent product work.                                  |
| Change a planned-workout date                                  | Already implemented by `update_planned_workout` with `scheduled_date`. Re-verify through the affected athlete's MCP client before resolving the request; do not build a second scheduling path.                                                                                                                           |
| Automated block-level training review                          | **Phase 4 candidate.** Start only from real beta use. The review must name its input window, missing data, skipped movements, notes, RPE coverage, and uncertainty, then propose rather than apply a next block.                                                                                                          |
| Fatigue-cost and eccentric-load metadata                       | **Phase 4 candidate, only as qualitative context.** Keep coach-curated labels such as local/systemic/eccentric cost; never present a physiological recovery calculation or readiness score.                                                                                                                               |
| Exercise role and training-purpose metadata                    | **Phase 4 candidate.** Model a small controlled role vocabulary only when it enables a visible plan or review decision, such as what workload can move or be trimmed.                                                                                                                                                     |
| Progression beyond estimated 1RM                               | **Phase 4 candidate.** Extend the review evidence model to rep capacity, timed work, unilateral benchmarks, and explicitly defined athlete metrics. Do not turn all movements into a false e1RM comparison.                                                                                                               |
| Training-objective priority hierarchy                          | **Phase 4 candidate.** Make primary, secondary, and development priorities explicit before the planner uses them to trade work across a week.                                                                                                                                                                             |
| Cross-modality weekly-load dashboard                           | **Phase 5.** Requires a trusted endurance source. Show transparent components, including mileage, elevation, key/long runs, strength work, session RPE, and recovery notes; no single load or readiness score.                                                                                                            |
| Protected external coach plan with an assistant strength layer | **Phase 5.** Import the running coach's plan as a read-only, provenance-carrying source. The assistant may draft or rearrange strength around it, but never silently alter the protected source.                                                                                                                          |
| Running-load context and endurance integration                 | **Phase 5.** A personal Intervals.icu connection is the preferred first source, but only after the operational foundation below: consented connect/revoke, encrypted server-side credential handling, pagination, correction reconciliation, scheduled sync with visible failure, and an empty source treated as UNKNOWN. |

M-01 shipped on `main` and still does not authorize adjacent product work or
an automatic feedback cleanup. All other rows retain the phase gates below.

## Interim endurance-context contract

This is an MCP-native, optional preflight, not a required PWA form or a
dependency of ordinary strength logging.

- For a strength-only request, MCP proceeds without an endurance questionnaire.
- MCP takes endurance into account when the athlete provides it in the
  conversation or a trusted integration supplies it. It does not proactively
  ask about endurance during beta.
- When no endurance context is supplied, the planner makes a strength-only
  recommendation. It does not infer "no runs," claim to coordinate a combined
  schedule, or make recovery/interference claims it cannot support.
- Do not build a second endurance state store merely to avoid a question MCP
  was not asked to pose.

## Active execution phases

Follow these phases in order. A later phase can be researched, but code and
release work starts only after the preceding phase's exit gate passes.
"Engineering" means the implementation owner; Colt owns product policy,
access settings, beta invitations, and release acceptance.

### Phase 0: Establish a truthful safety backlog

**State:** Complete on `main` (PR #8, 2026-09-21). Plan at
`docs/superpowers/plans/2026-09-21-phase-0-safety-backlog.md`. Ledger at
`docs/roadmaps/release-ledger.md`. Remaining operational: A-02 still
`needs live proof` until production `COACH_ALLOWED_USERS` is set.

**Owner:** Colt for settings and acceptance; Engineering for evidence.

- Set `COACH_ALLOWED_USERS` to Colt's wife's user UUID only, or turn off the
  in-app coach until that narrow allowlist is in place. The current code
  deliberately permits everyone when the secret is unset, which is
  unacceptable for a public signup surface with an owner-paid model key
  (A-02). This does not restrict the beta's MCP path.
- Re-run every audit item touched by the post-audit merge. Start with A-94,
  A-105, and A-119, because their cited missing flows now have merged code.
  Mark each item `open`, `fixed with test`, `needs live proof`, or `not
reproducible`; never silently remove it.
- Create one release ledger with finding ID, boundary, owner, regression test,
  production proof, rollback, and state. It replaces status claims scattered
  across `docs/plan.md`, old implementation plans, and the audit.
- Keep the owner-paid in-app coach to its intended fallback users. MCP remains
  the primary beta interface; do not broaden the in-app coach merely because a
  private beta account exists.

**Exit gate:** a reviewer can see the current state of every stop-release item
and the coach cannot spend money for an unapproved account.

### Phase 1: Make release and identity safety real

**State:** Code merged and deployed (PR #10, PR #12). Exit gate open on
production evidence: A-02 `needs live proof` and A-135 lacks served-SHA
readback. A-134 stays `open` by policy. A-137/A-138 are deferred to Phase 5
(2026-09-24). See `release-ledger.md`.

**Starts after:** Phase 0's ledger and coach boundary are complete.

**Owner:** Engineering; Colt accepts the access and deployment policy.

Build this as two independently releasable slices. Locked 2026-09-21:
unset `COACH_ALLOWED_USERS` is 503; the in-app coach cannot confirm
(`expires_at IS NOT NULL`); parent ownership is composite FKs; GitHub
Actions CI is billed-out, so deploy must not wait on CI.

1. **Admission and tenant boundaries:** repair and test tunnel readiness
   (A-01), fail-closed coach admission and an atomic quota reservation (A-02,
   A-07), cross-user parent validation (A-03), `NaN` rejection (A-49), push
   endpoint SSRF controls (A-69), credential handling (A-149, A-159), and
   prompt-injection boundaries around write-capable coaching (A-150 to A-152).
   Use direct cross-user and malformed-input tests, not only unit tests.
   Spec: `docs/superpowers/specs/2026-09-21-phase-1-admission-design.md`.
   Plan: `docs/superpowers/plans/2026-09-21-phase-1-admission-tenant.md`.
2. **A real release contract:** fail a PWA deployment when required
   Supabase settings are invalid; fail (not skip-success) a required
   backend deploy when `supabase/` changed and secrets are missing; smoke
   the published PWA and MCP `/health`; document Pages revert and
   forward-only migrations. Do **not** wait on `ci.yml` while Actions
   billing keeps CI red. A-26 is already fixed. A-134 stays open
   (deferred, not a fifth ledger state). Spec:
   `docs/superpowers/specs/2026-09-21-phase-1-release-contract-design.md`.
   Plan: `docs/superpowers/plans/2026-09-21-phase-1-release-contract.md`.

**Exit gate:** a deliberately broken PWA/backend build cannot publish, a
missing configuration fails visibly, a deployed release has its own smoke
receipt, and the access/tenant tests reject every adversarial fixture.

### Phase 2: Prove the training record survives real use

**State:** In progress, started early (accepted 2026-09-24). Plan-write
atomicity and locking, late-set session restore and durable-first logging
shipped in PR #12; A-92 and A-107 are closed with tests. Confirmed still
open: A-84 and A-91. Not re-verified since the audit: A-06, A-90, A-143,
A-148, A-203 to A-206 and the screen-race items. No seeded browser E2E suite
and no phone acceptance run yet.

**Starts after:** Phase 1's deployment and tenant-boundary gates pass. (This
ordering was crossed on 2026-09-24; the exit gate below still applies.)

**Owner:** Engineering; a real lifter performs acceptance on a phone.

Work by lifecycle, not screen:

- **Durable capture:** do not show a normal logged set until its outbox write
  is committed; make enqueue's post-commit error unambiguous; add online retry
  recovery (A-107, A-143, A-206).
- **Correct owner and terminal state:** serialize auth/cache transitions,
  prevent held-outbox disclosure, require affected-row readback for session
  close, and prevent stale cross-device discard/end races (A-06, A-90, A-91,
  A-148, A-204, A-205).
- **Truthful plan history:** replace multi-request workout/plan replacement
  with an idempotent transactional database boundary; preserve historical
  prescription/training-max meaning rather than dynamically rewriting
  adherence (A-23, A-84, A-92, A-203).
- **Screen races and interruption:** request-generation/cancellation guards in
  Plan, Today, and History; defer a service-worker update while any session
  draft exists, not merely while an active-session pointer exists (A-04,
  A-05, A-13).

Add a small seeded browser E2E suite in this wave: sign in, create/confirm a
plan, start/resume/log/correct/finish a session, go offline/online, and prove a
second friend-beta user cannot see or write the first user's data. This is
multi-account safety testing, not an invitation to build shared coaching or
collaboration.

**Exit gate:** the phone run completes once offline and once across an update;
each session has exactly one valid terminal state; a simulated retry or second
device cannot duplicate, hide, or disclose a set; browser E2E and live
readback pass.

### Phase 3: Start the small friend beta

**State:** Not started. Blocked on Phase 2.

**Starts after:** Phase 2's phone, browser, and live-readback gate passes.

Colt provisions three to five friend accounts. Each athlete immediately picks
Claude or ChatGPT and uses MCP for planning and review, while the PWA remains
available for manual planning and phone logging. The in-app coach stays limited
to Colt's wife. There is no scripted onboarding, weekly survey, activation
target, or collaboration feature.

Collect feedback through PWA Report a problem and MCP `submit_feedback`; Colt
reviews it while coding or updating the app. Keep running the beta while it is
useful. Pause it for any credible data-loss, cross-account, or release-integrity
defect.

**Exit gate:** none by metric. Colt decides whether the app is useful enough
to keep inviting friends, pause for a repair, or move on to the feedback-driven
improvements in Phase 4.

### Phase 4: Make the private lifter's plan legible

**State:** Not started. Blocked on real beta use from Phase 3.

**Starts after:** Phase 3 has generated real usage or a clear feedback-backed
need. Do not build this merely because it appears next on a list.

**Owner:** Product and Engineering.

Ship the smallest strength-only activation loop indicated by real use:

- O-02 confirmed plan/phase dashboard, which makes an MCP-created strategy
  intelligible on the phone where the session is logged.
- O-01 guided calibration is optional. It must not displace MCP as the
  primary planning path, and it creates only an explicitly unconfirmed starter
  proposal.
- An athlete may instead create and manage a plan manually in the PWA. Beta
  does not force a coach screenshot, MCP-created plan, or a single entry path.
- Use endurance context only when MCP receives it, with no new PWA flow,
  proactive questionnaire, or durable endurance-state abstraction.
- Finish live acceptance of the already-merged check-in, skip, and
  coach-observation paths. They are foundations for O-03 explainable
  progression proposals and O-04 weekly exception review, not proof those
  product loops already work.
- If beta feedback confirms the need, take the block-review, qualitative
  exercise-metadata, broader progression-evidence, and objective-priority
  requests from the feedback-intake table in that order. Each proposal remains
  reviewable and confirmable; none may rewrite a plan automatically.

Instrument three outcomes: first-session completion, one completed MCP review,
and return for the following week's first session. Do not add streaks, a
readiness score, automatic program rewrites, or general multi-user
collaboration.

**Exit gate:** a new athlete can reach a first useful plan and confirm it; an
athlete can see the current phase; a proposal names its inputs, uncertainty,
expiry, and confirm/override outcome.

### Phase 5: Make endurance a product only after the core is trusted

**State:** Not started. E0/E1 schema already deployed; product work waits.

**Starts after:** strength logging is trusted in the friend beta and the
operational failures below have an owner and evidence plan.

**Owner:** Product and Engineering; Colt supplies real-user acceptance data.

Endurance is a required future planning input, not a feature wishlist: planning
strength without knowing hard endurance days, long runs, current volume, and
constraints eventually becomes unsafe or unhelpful. It remains deferred because
the strength-only product must first be trustworthy, and the endurance product
is not yet operational. E0/E1 schema and sync foundations are deployed, but
the audit still identifies provider pagination/correction,
connection/revocation, scheduling, credential, and prompt-delivery failures
(A-21, A-74 to A-76, A-121, A-139 to A-141, A-157, A-159).

Before the integration is trustworthy, MCP considers endurance only when it is
given by the athlete. It may not infer "no runs" from an empty integration,
and it does not need a new PWA flow or durable context store.

First finish the operational foundation: a consented connection and revoke
flow, bounded/paginated/correctable sync, encrypted credential treatment,
scheduled polling with active failure visibility, and prompt delivery. Then
hold the documented E0/E1 real-world gates: 12 months of reconciled activity
history, 14 days of subjective capture, two weekly OSTRC reports, and a real
next-morning prompt. Only then begin E2 state estimation, E3 constraint intake,
E4 calendar representation, E5 draft blocks, and E6 replanning.

Never pull forward deep FIT analysis (E7), automatic planner actions, a
readiness score, injury prediction, or finish-time prediction.

After those operational gates, use Intervals.icu as the first personal
read-only source. Its data can support the transparent cross-modality weekly
view and scheduling strength around an externally coached running plan, but
the imported plan remains protected and retains its source and sync provenance.

**Exit gate for E2:** the returned state carries `missing[]`, has no invented
capacity, and strength logging remains operational with the integration down.

### Phase 6: Measured scale and recovery

**State:** Not started. Blocked on a measured bottleneck or recovery need.

**Starts after:** a measured bottleneck or recovery requirement appears.

**Owner:** Engineering, with a release owner for recovery exercises.

Profile before changing architecture. In order: O-14 route/capability code
splitting, O-15/O-16 read models, O-17 reference-read coalescing, O-18 catalog
delivery, O-19 compact coach context/quota aggregates, then O-20/O-21 database
optimisation. Pair that work with O-22 typed database contracts, O-24
supply-chain scanning, and O-25 backup/restore drills. Do not materialize views
or rewrite RLS solely because an advisor suggests it.

**Exit gate:** a recorded before/after improvement in phone load or query cost,
unchanged RLS/offline behavior, and a successful sanitized restore drill with
measured RPO/RTO.

## Confirmed beta model

- A small named group of friends receives PWA access after the safety gates.
- Every participant plans and reviews through their own Claude or ChatGPT MCP
  connection.
- The in-app coach is not enabled for the cohort. It remains a one-person
  fallback for Colt's wife.
- Beta feedback uses the existing durable `feedback` record, not a survey.
  The PWA's Report a problem path files immediate app bugs; MCP's existing
  `submit_feedback` tool files a bug, feature, data gap, or question found
  during planning or review. MCP reads `list_feedback` before filing and tells
  the athlete what it recorded. An entry is resolved only after the athlete
  says the outcome is acceptable.
- Before analysing cohort feedback by client, make new MCP submissions report
  source `mcp` rather than the current literal `claude`. Keep historical
  `claude` rows intact; this is provenance cleanup, not a release blocker.
- Feedback is about trustworthy capture, clear plan visibility, and MCP
  usefulness, not coach collaboration or social features.
- Colt reviews the feedback queue while coding or updating the app. There is
  no scheduled beta survey or standing review meeting.

## Operating ownership

Colt is the release owner for this private beta. Engineering produces the
release receipt and runs automated checks; Colt runs the real-device acceptance
gate before adding or expanding friend access. A green GitHub run is not that
gate.

## Deliberately deferred

No social layer, nutrition, streaks, readiness score, injury/finish-time
prediction, automatic deep activity ingestion, broad multi-user coach access,
or performance optimisation without a measured bottleneck. These compete with
the reliability budget and do not improve the first trustworthy workout.
