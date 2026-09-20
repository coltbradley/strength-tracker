# Consolidated roadmap, 2026-09-19

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

The first beta is a small, named group of friends, not a coaching product or a
collaboration test. Each athlete uses their own Claude or ChatGPT MCP client
for planning and review. The in-app coach is enabled only for Colt's wife;
every other beta participant uses the PWA plus MCP.

The first beta success event is: a new lifter completes three real sessions,
reviews one through MCP, and returns the following week without manual rescue.
The beta-ready bar is deliberately narrower than full public launch: sign in,
plan, offline logging, safe finish, truthful review, and a release that has
direct production readback.

The system audit is an evidence backlog, not a current release verdict. It was
committed at `4a854c2`; `main` subsequently merged the live-session adaptation
work at `eb17a1c`. The merge added the check-in redesign, session-skip history,
and coach-observation loop. Any finding these changes may affect is
**needs re-verification**, not automatically fixed.

## Verified starting point

| Area | Current evidence | What it does not prove |
| --- | --- | --- |
| Local engineering baseline | PWA: 81 test files / 934 tests, typecheck, and production build passed on 2026-09-19. Relay tests, database validation, and selected-column validation also passed. | A phone, browser, managed Supabase, or provider workflow. |
| GitHub CI | CI run 35477247194 passed for `eb17a1c`. | A deployment or production behavior. |
| Deployed database | Remote migration history matches local through `20260917030000_fk_indexes`. | That each product path uses the migration correctly. |
| Edge Functions | `mcp-server` v43, `coach` v18, `push-alerts` v6, and `endurance-sync` v3 are active. | That a particular source SHA or a real provider/phone transaction works. |
| PWA publishing | Deploy run 35166323767 published the PWA for `c391a54`. Its Supabase job was skipped. | Schema/function parity, or a post-deploy smoke test. |

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

## Interim endurance-context contract

This is an MCP-native, optional preflight, not a required PWA form or a
dependency of ordinary strength logging.

- For a strength-only request, MCP proceeds without an endurance questionnaire.
- When a user asks for combined-training advice, or identifies current
  endurance work, MCP asks for a compact confirmed summary: current hard days
  and long session, expected next-seven-day endurance work, near-term event or
  goal, and any injury, recovery, or availability constraint that changes the
  strength recommendation.
- An explicit "I am not doing endurance work" is enough to plan strength-only
  work. An unanswered question remains UNKNOWN, never "no endurance."
- Until sync is trusted, the summary is used for that planning decision. Do
  not build a second endurance state store merely to avoid asking a relevant
  question in MCP.
- The planner may make a strength-only recommendation with missing endurance
  context, but it must label the limitation and avoid claims about combined
  schedule, recovery, or interference.

## Roadmap

Dates are proposed planning windows, not commitments. "Engineering" means the
implementation owner; Colt owns product policy, access settings, and release
acceptance.

### 0. Contain and make the backlog truthful, Sep 19-22

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

### 1. Release and identity safety, Sep 22-Oct 2

**Owner:** Engineering; Colt accepts the access and deployment policy.

Build this as two independently releasable slices.

1. **Admission and tenant boundaries:** repair and test tunnel readiness
   (A-01), fail-closed coach admission and an atomic quota reservation (A-02,
   A-07), cross-user parent validation (A-03), `NaN` rejection (A-49), push
   endpoint SSRF controls (A-69), credential handling (A-149, A-159), and
   prompt-injection boundaries around write-capable coaching (A-150 to A-152).
   Use direct cross-user and malformed-input tests, not only unit tests.
2. **A real release contract:** make CI a prerequisite for deployment; fail a
   PWA deployment when required Supabase settings or a required backend deploy
   is missing; add a release manifest that binds commit, migrations, function
   versions, and PWA build; add deployed auth/MCP/PWA smoke checks; document a
   tested rollback decision. This addresses A-24 to A-26 and A-134 to A-138.

**Exit gate:** a deliberately broken PWA/backend build cannot publish, a
missing configuration fails visibly, a deployed release has its own smoke
receipt, and the access/tenant tests reject every adversarial fixture.

### 2. Training-record correctness, Oct 5-16

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

### 3. Make the private lifter's plan legible, Oct 19-30

**Owner:** Product and Engineering.

Only after Wave 2, ship the smallest strength-only activation loop:

- O-02 confirmed plan/phase dashboard, which makes an MCP-created strategy
  intelligible on the phone where the session is logged.
- O-01 guided calibration is optional. It must not displace MCP as the
  primary planning path, and it creates only an explicitly unconfirmed starter
  proposal.
- Add the optional MCP endurance preflight above for combined-training changes,
  with no new PWA flow or durable endurance-state abstraction.
- Finish live acceptance of the already-merged check-in, skip, and
  coach-observation paths. They are foundations for O-03 explainable
  progression proposals and O-04 weekly exception review, not proof those
  product loops already work.

Instrument three outcomes: first-session completion, one completed MCP review,
and return for the following week's first session. Do not add streaks, a
readiness score, automatic program rewrites, or general multi-user
collaboration.

**Exit gate:** a new athlete can reach a first useful plan and confirm it; an
athlete can see the current phase; a proposal names its inputs, uncertainty,
expiry, and confirm/override outcome.

### 4. Endurance becomes a product only after the core is trusted, November+

**Owner:** Product and Engineering; Colt supplies real-user acceptance data.

Endurance is a required future planning input, not a feature wishlist: planning
strength without knowing hard endurance days, long runs, current volume, and
constraints eventually becomes unsafe or unhelpful. It remains deferred because
the strength-only product must first be trustworthy, and the endurance product
is not yet operational. E0/E1 schema and sync foundations are deployed, but
the audit still identifies provider pagination/correction,
connection/revocation, scheduling, credential, and prompt-delivery failures
(A-21, A-74 to A-76, A-121, A-139 to A-141, A-157, A-159).

Before the integration is trustworthy, combined-strength planning uses the
optional MCP preflight above. It may not infer "no runs" from an empty
integration, and it does not need a new PWA flow or durable context store.

First finish the operational foundation: a consented connection and revoke
flow, bounded/paginated/correctable sync, encrypted credential treatment,
scheduled polling with active failure visibility, and prompt delivery. Then
hold the documented E0/E1 real-world gates: 12 months of reconciled activity
history, 14 days of subjective capture, two weekly OSTRC reports, and a real
next-morning prompt. Only then begin E2 state estimation, E3 constraint intake,
E4 calendar representation, E5 draft blocks, and E6 replanning.

Never pull forward deep FIT analysis (E7), automatic planner actions, a
readiness score, injury prediction, or finish-time prediction.

**Exit gate for E2:** the returned state carries `missing[]`, has no invented
capacity, and strength logging remains operational with the integration down.

### 5. Measured scale and recovery, after proven use

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

## Remaining decisions

1. Name the release owner who can run the real-device acceptance gate. A green
   GitHub run is not that role.
2. Decide the minimum MCP onboarding proof for each beta athlete: a completed
   OAuth authorization plus read-only query, then a separate approved plan
   write.

## Deliberately deferred

No social layer, nutrition, streaks, readiness score, injury/finish-time
prediction, automatic deep activity ingestion, broad multi-user coach access,
or performance optimisation without a measured bottleneck. These compete with
the reliability budget and do not improve the first trustworthy workout.
