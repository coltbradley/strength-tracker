# Endurance layer: build plan

The strength log grows an endurance half and a planning engine above both. The
evidence base is [endurance-research.md](endurance-research.md); every rule
referenced by a phase below is tagged and cited there. The build itself, with
assigned migration numbers, exact table shapes and file ownership, is
[superpowers/plans/2026-09-06-endurance-implementation-spec.md](superpowers/plans/2026-09-06-endurance-implementation-spec.md),
which also records the six assumptions in this document that turned out to be
wrong or unexamined.

## The invariant

**The strength app keeps working, unchanged, at every commit.**

This is not a goal, it is a gate condition repeated in every phase. Concretely,
at the end of each phase all of the following must still hold:

- `cd pwa && npm test` green, with no test deleted or skipped to make it so.
- `node scripts/validate-db.mjs` green: the full migration chain applies in
  PGlite.
- Today, Session, History, End and Plan render and function with an endurance
  layer that is empty, half-populated, and fully populated.
- A user who never touches the endurance features sees no new required step, no
  new empty state where content used to be, and no additional network dependency
  on the logging path.
- `sets` remains append-only. No phase adds an update or delete policy.
- The offline outbox still flushes strength writes with the endurance
  integration unreachable.

The last two matter most. Endurance data arrives by sync from a third party;
strength data is the only copy and is written by a phone in a basement. They are
different reliability classes and the endurance half may never become a
dependency of the strength half.

## Ordering principle

Capture before planning. Three reasons, in descending order of force:

1. The block generator is worthless without a state estimate, and the state
   estimate is worthless without history. Building `draft_block` first produces
   a tool that writes confident twelve-week plans out of nothing.
2. Subjective self-report outperforms objective measures (Saw 2016, `[STRONG]`).
   The cheapest thing to collect is the best signal, and it only accrues in
   real time. Every week without it is a week that cannot be recovered.
3. Capture phases carry no risk to the invariant. They add tables and reads.
   The planner touches the calendar the strength app already renders.

This is the opposite order from where the interest is. It is still the order.

---

## Phase E0: activities land

Endurance actuals become rows, with no planning and no UI.

**Build**
- `activities` table. Append-only, `external_id` unique per user, `source`.
  This is a third write-ownership class (see decisions.md) and needs its
  entry there before the migration lands.
- intervals.icu ingest: an edge function pulling activities and the wellness
  endpoint, keyed by a per-user API key held as a secret.
- Backfill of the full available history.
- `v_live_activities`, following the `v_live_sets` idiom.
- `v_weekly_endurance`: distance, duration, ascent, descent, bucketed by
  `app_tz(user_id)`.

**Do not build**
Any UI. Any planning. Any derived score. Strava API OAuth.

**Gate**
- 12 months of history loaded, and `v_weekly_endurance` reproduces the weekly
  volume computed independently from the Strava MCP within 2%.
- Ascent and descent are stored separately and both are non-null for GPS
  activities.
- Re-running the ingest twice changes no rows (idempotent on `external_id`).
- The ingest function being down for 24 hours has no observable effect on the
  PWA.
- The invariant holds.

---

## Phase E1: the athlete answers

The subjective capture layer. This is the phase that accrues value while later
phases are built, so it ships early and runs for the whole project.

**Build**
- `daily_readiness`: one anchored row per date. Sleep hours, sleep quality,
  fatigue, soreness, stress, mood, each its own column plus `recorded_at`.
  No composite score, ever.
- `checkins`: many per day, typed `pre_session | post_session | spontaneous |
  prompted`. Energy, feeling, free note, nullable `session_id`, `recorded_at`.
  The `post_session` row is where sRPE is collected, and its timestamp is part
  of the measurement.
- `symptom_reports`: one row per ISO week, OSTRC-O2 items as raw ordinals, plus
  `body_region`, `instrument_version`, `recall_window_end`. Severity derived in
  a view.
- `symptom_episodes`: the trending unit. Region, opened week, closed week,
  consecutive weeks, `is_substantial` derived.
- `pain_checks`: `session_id`, `phase ('during'|'post'|'next_morning')`,
  `nrs_0_10`, `captured_at`. The next-morning row is its own prompt.
- `red_flags`: one boolean per flag, plus `referred_at`.
- `report_prompts`: `scheduled_for`, `responded_at`, `channel`, `skipped`. The
  denominator, without which adherence cannot be measured.
- PWA: a check-in sheet reachable in one tap from Today, and the OSTRC weekly
  form.
- Prompts over the existing Web Push infrastructure: daily morning, weekly
  OSTRC, next-morning-after-a-run.
- Context block carries latest readiness and open symptom episodes, following
  the `coach_memory` rule that memory which must be fetched gets forgotten.

**Blocked on**
OSTRC v2 item text and scoring verified against Clarsen 2020, BJSM 54:390-6.
The tables can land before the wording; the prompts cannot.

**Do not build**
Any readiness score. Any injury risk column. Any passive alert. Any inference
from under 6 weeks of data.

**Gate**
- 14 consecutive days of `daily_readiness` captured on a real phone, including
  at least two days where the app was offline at prompt time.
- Two weekly OSTRC responses captured, and the severity view reproduces the
  published scoring on a hand-worked example.
- One next-morning pain check fired and answered the day after a real run.
- One symptom episode opened, extended across two weekly reports, and closed.
- `report_prompts` yields a computable adherence rate.
- The invariant holds.

---

## Phase E2: the system knows where you are

State estimation. The read that makes everything downstream honest.

**Build**
- `get_training_state` MCP tool returning, in one call:
  - **Aerobic state**: rolling 4 and 8 week volume in hours, duration by
    intensity zone against a versioned zone definition, recent benchmark efforts.
  - **Tissue-tolerance state**: longest run in the prior 30 days by duration,
    weighted eccentric descent dose, days since the last gap of 10+ days, and
    weeks since load last exceeded the current level.
  - **Strength state**: current training maxes, e1RM trend, sessions per week,
    weeks since the last session at or above 85%.
  - **Subjective state**: 7-day readiness trend against personal baseline, open
    symptom episodes, adherence.
  - `missing[]`: what could not be computed and why.
- `benchmark_efforts` table plus ingest of repeated Strava segment efforts, so
  the one evidence-backed objective fatigue marker has a home.
- Two-state modelling made explicit in the return shape. Never one number.

**Do not build**
A composite. A prediction. A recommendation. This phase reports state only.

**Gate**
- The tool returns a complete state vector for a real user.
- With history truncated to 3 weeks, it reports `missing` rather than guessing,
  and nothing downstream treats a missing value as zero.
- Replayed across the known 2026-07-26 to 2026-08-21 gap, the aerobic and
  tissue-tolerance states move independently and on different timescales, with
  the aerobic state recovering first. If they move together, the model is wrong
  and this phase is not done.
- Benchmark efforts show a usable series across at least 8 repetitions of one
  segment.
- The invariant holds.

---

## Phase E3: the target and the constraints

The facts that cannot be derived. Mostly a conversation, stored once.

**Build**
- `events`: date, distance, **ascent and descent separately**, technicality,
  surface, altitude, expected temperature, cutoffs, aid spacing, crew and pole
  rules. Descent gets its own column because nothing on the market has one and
  it drives the eccentric block.
- `athlete_constraints`: days available, per-day time ceiling, long-day ceiling,
  equipment and terrain access, strength floor, and known disruptions.
- **Training environment stored separately from race environment.** Conflating
  them is the defect that makes Runna's terrain enum useless.
- Intake tools writing both, and a Calendar-derived disruption proposal
  ("I see a multi-day hold Nov 11-15, is that a trip?") that is confirmed once
  and stored, never silently assumed.

**Gate**
- A real 50K encoded with ascent and descent distinct and non-null.
- `get_training_state` plus the event is sufficient to name every rule from the
  research doc that will apply to this athlete, with none requiring a value that
  is absent.
- An intake tool called with an incomplete event returns a named missing-field
  list, not a partial write.
- Every inferred fact was proposed and confirmed before storage. Nothing is
  silently assumed.
- The invariant holds.

---

## Phase E4: endurance days on the calendar

The schema for a planned run, and both renderers.

This is the highest-risk phase, because it is the first one that changes what
the existing app renders. Two current behaviours break silently unless they are
fixed in the same migration that causes them:

- `v_plan_workouts.exercise_count` counts `prescriptions` rows only, so a day
  holding only a run renders as a DRAFT. The draft rule exists because an empty
  dated day accused someone of skipping a session nobody programmed; a
  programmed run day reading as a draft is that bug with the sign flipped.
- DONE is decided in `pwa/src/lib/data.ts` from a session with `ended_at not
  null`. A run has no session, so a completed run day would read as MISSED.

**Build**
- `entry_count` on `v_plan_workouts` (prescriptions plus efforts), with
  `exercise_count` left unchanged so existing selects are unaffected.
- `v_training_days`, the union of finished sessions and non-discarded
  activities, so the PWA and the MCP server answer "did I train" identically.
- `time_of_day` on `prescriptions` and `planned_efforts`. This gives a day
  holding both a total order AND unblocks the 6-hour separation rule below, in
  one nullable column, using the adjacency idiom the repo already uses for
  `section` and `superset_group`.
- `planned_efforts`, hanging off `planned_workouts` beside `prescriptions`, so
  one day holds a lift and a run. Shape is `workout -> step -> repeat-block`,
  matching TrainingPeaks JSON, .zwo, FIT `workout_step` and the intervals.icu
  DSL, all of which converge on it. Fields: `duration_type (time|distance|open)`,
  `target_type` with min and max, terrain, `vert_m`, `repeat_group`,
  `repeat_count`, coach `notes`.
- `blocks`, or `block_id` on `planned_workouts`, so a block is addressable and
  can be superseded.
- Today and the plan editor render both modalities, applying the same rules to
  both (the section-label rule already in CLAUDE.md is the precedent).
- `update_planned_workout` learns efforts, replacing a day's efforts wholesale
  the way it already does prescriptions.

**Gate**
- A hand-authored week containing an interval session, a long run with a vert
  target, and two strength days renders correctly on Today and in the editor,
  and the two agree.
- That week round-trips through `update_planned_workout` without losing
  structure, ordering, or repeat grouping.
- A day with logged work against it is refused, matching the existing trigger.
- An empty endurance day reads as a DRAFT, not a missed workout, per the
  existing rule.
- Deleting the endurance half of a mixed day leaves the strength half intact.
- The invariant holds.

---

## Phase E5: the block generator

The tool the whole project is for. It arrives fifth because now it has inputs.

**Build**
- `draft_block(phase_id, weeks, pattern, progression, constraints)` and
  `confirm_block`. Server expands a weekly pattern plus a progression rule into
  dated days, lands unconfirmed, returns a week-shaped summary rather than 60
  days of JSON.
- Backward solving from race date for the modifier blocks: altitude, heat, gut,
  eccentric/descent, taper.
- A constraint checker the generator runs against its own output, encoding at
  minimum:
  - Long run <= 110% of the longest run in the prior 30 days, in duration.
  - Hard descent exposure every 10 to 14 days from 6 to 8 weeks out; 5 to 9 days
    between high-eccentric sessions; eccentric block ends >= 3 weeks out.
  - Strength floor: >= 1 lower-body session per week at >= 85% of training max.
    Volume absorbs pressure, load never does.
  - Strength and endurance separated by >= 6 hours; never < 3; no quality run
    within 24 hours after a heavy lower-body session, 48 after an eccentric one;
    never strength on the long-run day.
  - Taper: volume -41 to -60%, intensity and frequency held, <= 21 days.
  - Progress load OR vertical in a given week, never both.
  - Weekly volume increase > 30% raises a warning.
- `pattern` and `progression` are machine-readable; the prose in
  `plan_phases.progression` is generated from the rule, not authored beside it.
  A service that cannot re-derive is just a conversation with a database.

**Formerly blocked, now resolved.** The 6-hour separation rule needed a
time-of-day on planned days. That column lands in E4 on both `prescriptions` and
`planned_efforts`, so E5 is unblocked. Where `time_of_day` is null the rule
warns rather than blocks, because a plan that does not say when is unverifiable
rather than wrong.

**Gate**
- A generated 12-week block satisfies every constraint above, proven by the
  automated checker, not by reading it.
- Each constraint has a test that fails when the constraint is removed.
- Given an unreachable target, the tool returns what IS reachable with the
  binding constraint named. It does not refuse and it does not silently produce
  a plan that violates a rule.
- The generated block cites, per decision, which rule produced it, so the
  explanation to the athlete is derived rather than narrated.
- Nothing in the output claims a predicted finish time or an injury-risk
  reduction.
- The invariant holds.

---

## Phase E6: the plan meets reality

The differentiator. Every platform surveyed fails here.

**Build**
- `disruptions`: type, date range, severity, **backdate-able**. The universal
  complaint about existing tools is the inability to record a gap that already
  happened.
- `replan(from_date, reason, constraints)`: re-derives forward, keeping the
  objective and remaining phases, re-solving with fewer weeks and lower current
  capacity. Supersedes rather than deletes, following `training_plans`.
- Return-from-gap gated on the **tissue-tolerance** state, not the aerobic one.
- Triage acting on symptom data: substantial OSTRC problem proposes a plan
  modification; three consecutive weeks in one region recommends a clinician;
  any bone-stress red flag stops running and refers same day.
- Prompted questions from passive signals, phrased as questions and never as
  alerts. "Cadence was down 4% on the run you flagged" annotates a report; it
  never raises one.

**Gate**
- Replaying the real 26-day gap produces a restart gated on tissue tolerance,
  with the first week's long run at or below 110% of the longest run in the
  prior 30 days.
- A disruption recorded three weeks after the fact re-plans correctly and does
  not mutate days already trained.
- A substantial OSTRC week produces a visible plan proposal, not a notification.
- A single red flag triggers referral without requiring a second.
- No passive signal alone produces any user-visible alert. Test this by
  fabricating a large cadence drop and asserting silence.
- Week-to-week OSTRC deltas below the individual SDC of 35 produce no
  escalation.
- The invariant holds.

---

## Phase E7: deep session data

Optional, and deliberately last. The most objective, most expensive, most
seductive data in the stack.

**Build**
- A FIT parse tool taking an attached file and writing about thirty derived
  numbers: quartile splits of moving time, grade-band splits, GCT balance
  distribution, weighted eccentric descent dose.
- No pipeline. The file is attached in chat; the tool parses and writes.

**Do not build**
Per-second stream storage. Automatic ingestion, until the manual path is being
used weekly. Any injury inference.

**Gate**
- Within-session decay is visible across the quartiles of a real long run.
- Grade-band splits separate descending from climbing performance on a real
  trail run.
- Storage per activity stays under a kilobyte.
- The invariant holds.

---

---

## Phase E8: the coach learns the layer

E0 to E7 produce a schema and a generator with nobody driving them. E8 adds the
STATE line to the context block, gates `draft_block` / `confirm_block` /
`replan` to Claude Desktop only (the `set_training_plan` precedent: strategy is
set at a desk, tactics between sets), and adds the prompt rules that stop the
coach predicting finish times, claiming injury prevention, or averaging the two
states. See the spec for the gate.

## Phase E9: evals and deploy

The phase that decides whether any of it works. Nine planning-eval cases
asserted against the constraint checker rather than against prose, the existing
coach eval extended, and `docs/deploy.md` walked end to end. Without E9 there is
no way to tell a working planner from a plausible one.

## Sequencing notes

E0 and E1 can run in parallel; they share no tables. E1 should start as early as
possible regardless of everything else, because subjective data only accrues
forward.

E2 depends on E0. E3 is a conversation and can happen any time after E2 exists
to say what is already known. E4 depends on nothing but is pointless before E3.
E5 depends on E2, E3 and E4. E6 depends on E5 and E1.

E7 depends on nothing and can be pulled forward if a specific question demands
it, at the cost of building objective machinery before the subjective baseline
exists, which the evidence says is the wrong trade.

## What is explicitly not in this plan

- Run logging in the PWA. The watch is the logger.
- Strava API OAuth. The MCP surface covers ad-hoc reading; intervals.icu covers
  the programmatic path.
- Multi-user anything. Every source constraint changes at that point.
- A readiness score, an ACWR gauge, a TSB chart, a predicted finish time. See
  the refusals list in the research doc.
