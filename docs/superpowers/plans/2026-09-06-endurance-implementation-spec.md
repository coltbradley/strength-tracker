# Endurance layer: implementation spec, E0 to E9

The design is [../../endurance-plan.md](../../endurance-plan.md); the evidence
is [../../endurance-research.md](../../endurance-research.md). This file is the
build: assigned migration numbers, file ownership, exact table shapes, and the
gate each phase must pass before the next starts.

Written to the repo's standing rules: TypeScript strict, one stylesheet with
tokens only, errors never swallowed, tests beside the code, migrations
append-only, a `docs/decisions.md` entry for every deviation. Run before every
commit:

```bash
node scripts/validate-db.mjs && node scripts/check-selects.mjs
cd pwa && npm ci && npm run typecheck && npx vitest run && npm run build
export PATH=/tmp:$PATH   # deno unpacked there
(cd supabase/functions/mcp-server && deno check index.ts)
(cd supabase/functions/coach && deno check index.ts)
```

Sandbox constraint carried forward from the 2026-09-05 round: `jsr.io` is
blocked, so prefer `npm:` or WebCrypto over `jsr:` in new function code.

## Assumptions challenged before writing this

Six things in the first draft of the plan were wrong or unexamined. Recording
them here because the corrections shape the schema.

**1. "A run creates a session."** Rejected. `sessions` is written only by the
PWA and that rule is load-bearing (it is what makes `sets` append-only
meaningful). Endurance actuals arrive by sync from a third party. Keeping them
out of `sessions` preserves the rule; the cost is that "did I train" becomes a
union, paid once in `v_training_days`.

**2. "Adding `activities` is additive and safe."** False, and this is the
highest-risk finding in the pass. Two existing behaviours break silently the
moment a planned day holds a run:

- `v_plan_workouts.exercise_count` counts `prescriptions` rows only. A run day
  has zero, so it renders as a DRAFT. The existing rule says a draft is a day
  nobody programmed. A programmed run day reading as a draft is the same class
  of bug as the empty-day accusation that rule was written to fix.
- DONE is decided in `pwa/src/lib/data.ts` from a session with `ended_at not
  null`. A run has no session, so a completed run day would read as MISSED.

Both must be fixed in the same phase that introduces efforts (E4), not later.

**3. "`planned_efforts` and `prescriptions` both order by `position`."**
Underspecified. A day holding both has no total order. Resolved below with
`time_of_day`, which also unblocks the 6-hour separation rule that
[endurance-plan.md](../../endurance-plan.md) listed as blocking E5. One column
solves both, and it uses the repo's existing adjacency idiom (consecutive rows
sharing a value ARE a block, like `section` and `superset_group`) rather than
adding a fourth grouping mechanism, which CLAUDE.md requires a decision entry to
do.

**4. "Ingest by webhook."** Rejected for v1. A webhook needs a public
unauthenticated endpoint and a shared secret to defend. Polling on a schedule is
simpler, has no attack surface, and endurance data is never latency-critical:
nothing in the app blocks on a run appearing within seconds. Webhooks stay an
optimisation for when polling proves insufficient.

**5. "E7 (FIT) is independent."** False. E2's tissue-tolerance state wants a
weighted eccentric descent dose, and E5's constraint checker gates on it. That
would make E5 depend on E7. Resolved by computing a COARSE dose in E2 from
activity summary descent plus Strava per-lap `avg_grade`, and treating the FIT
version as a refinement that changes the number's precision, not its existence.
The column is the same; only `dose_source` changes.

**6. "E7 is the end."** No. E0 to E7 produce a schema and a generator with no
coach able to drive them and no way to know if it works. E8 (the coach learns
the layer) and E9 (evals and deploy) are required for a working product.

## Migration numbers, assigned

| Phase | Migration | Owns |
| --- | --- | --- |
| E0 | `20260906010000_activities.sql` | `activities`, `v_live_activities`, `v_weekly_endurance` |
| E1 | `20260906020000_subjective_capture.sql` | `daily_readiness`, `checkins`, `symptom_reports`, `symptom_episodes`, `pain_checks`, `red_flags`, `report_prompts` |
| E2 | `20260906030000_benchmark_efforts.sql` | `benchmark_efforts`, `v_benchmark_series` |
| E3 | `20260906040000_events_constraints.sql` | `events`, `athlete_constraints`, `training_environments` |
| E4 | `20260906050000_planned_efforts.sql` | `planned_efforts`, `blocks`, `time_of_day` on `prescriptions`, `v_plan_workouts` rewrite, `v_training_days` |
| E6 | `20260906060000_disruptions.sql` | `disruptions` |
| E7 | `20260906070000_activity_detail.sql` | `activity_detail` |

E5, E8, E9 carry no migration.

---

# E0 · Activities land

Endurance actuals become rows. No UI, no planning, no derived score.

## Owns

`supabase/migrations/20260906010000_activities.sql`,
`supabase/functions/endurance-sync/**` (new),
`scripts/validate-db.mjs` (append a section headed E0).

## Schema

```sql
create table activities (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source         text not null check (source in ('intervals_icu','strava','manual','fit_upload')),
  external_id    text not null,
  sport          text not null,
  started_at     timestamptz not null,
  elapsed_s      int  not null check (elapsed_s >= 0),
  moving_s       int  check (moving_s >= 0),
  distance_m     numeric(10,1) check (distance_m >= 0),
  ascent_m       numeric(8,1)  check (ascent_m >= 0),
  descent_m      numeric(8,1)  check (descent_m >= 0),
  avg_hr         smallint check (avg_hr between 20 and 250),
  max_hr         smallint check (max_hr between 20 and 250),
  avg_power_w    numeric(6,1) check (avg_power_w >= 0),
  avg_cadence    numeric(5,1) check (avg_cadence >= 0),
  perceived_rpe  smallint check (perceived_rpe between 0 and 10),
  rpe_recorded_at timestamptz,
  name           text,
  planned_workout_id uuid references planned_workouts (id) on delete set null,
  discarded_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, source, external_id)
);
```

Notes on the shape, each of which is a decision:

- **`descent_m` is its own column, not derived.** The research pass found no
  platform stores it. It drives the eccentric block and the whole
  differentiator rests on it. It is nullable because a treadmill activity has
  none, and null means unknown, never zero.
- **`unique (user_id, source, external_id)`** is what makes replay idempotent,
  the same guarantee `sets` gets from client UUIDs. Re-running the ingest writes
  nothing.
- **`perceived_rpe` and `rpe_recorded_at` together.** Session-RPE validity
  depends on collection around 30 minutes post. The timestamp is part of the
  measurement, so a row with an RPE and no timestamp is a row whose RPE cannot
  be trusted. Both nullable; neither is inferred.
- **`discarded_at`, not delete.** Same soft-delete idiom as `sessions`,
  `programs`, `planned_workouts`. No delete policy.
- **`planned_workout_id` on delete set null**, matching `sessions`. Losing the
  plan must never lose the training.

RLS: owner select and insert; owner update restricted to `discarded_at`,
`perceived_rpe`, `rpe_recorded_at`, `planned_workout_id` (the sync writes as
service role; the user may only annotate). No delete policy.

`v_live_activities` mirrors `v_live_sets`: `discarded_at is null`. Every
endurance-derived view reads it, never `activities` directly.

`v_weekly_endurance` buckets by `app_tz(user_id)`, passing the row's user_id the
way every other calendar view does, and returns per ISO week: `runs`,
`total_moving_s`, `total_distance_m`, `total_ascent_m`, `total_descent_m`,
`longest_moving_s`, `longest_distance_m`.

## Function: `endurance-sync`

`verify_jwt` true. Resolves the user as `coach/index.ts` `resolveUser` does.

- `POST /backfill {since?}` pulls history from intervals.icu.
- `POST /poll` pulls anything newer than the newest `started_at` held, minus a
  48-hour overlap window because upstream activities get edited after upload.
- The intervals.icu API key is per-user and held in a new
  `integration_credentials` row, not an environment secret, because it is user
  data and this deployment is multi-user. Service-role only, RLS enabled with no
  policies, the `push_config` pattern.

Polling is invoked by the existing scheduled path. If none exists, `/poll` is
callable from the PWA on foreground, which is sufficient: nothing blocks on it.

## Do not build

Any UI. Any planning. Any score. Strava OAuth. Webhooks.

## Gate

1. 12 months of history loaded; `v_weekly_endurance` reproduces weekly volume
   computed independently from the Strava MCP within 2%.
2. `ascent_m` and `descent_m` both non-null for every GPS activity in the
   backfill. If descent is null across the board the upstream field is missing
   and the differentiator is dead; find out in E0, not E5.
3. Running the ingest twice changes zero rows. Assert by row-count and by
   `max(created_at)` before and after.
4. `validate-db.mjs`: user A cannot select user B's activities;
   `integration_credentials` is unreadable as `authenticated`; no delete policy
   exists on `activities`.
5. The sync function returning 500 for 24 hours has no observable effect on the
   PWA. Assert by running the existing PWA suite with the function unreachable.
6. **Invariant**: full gate suite green, no test skipped.

---

# E1 · The athlete answers

The subjective capture layer. Ships early and runs for the whole project,
because this data only accrues forward.

## Owns

`supabase/migrations/20260906020000_subjective_capture.sql`,
`pwa/src/screens/CheckIn.tsx` (new), `pwa/src/components/OstrcForm.tsx` (new),
`pwa/src/lib/checkins.ts` (+ test), `pwa/src/lib/coachContext.ts` (append),
`supabase/functions/push-alerts/**` (add prompt scheduling),
`supabase/functions/mcp-server/tools/checkins.ts` (new, read-only).

## Schema

```sql
create table daily_readiness (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  local_date    date not null,
  sleep_hours   numeric(3,1) check (sleep_hours between 0 and 24),
  sleep_quality smallint check (sleep_quality between 1 and 5),
  fatigue       smallint check (fatigue between 1 and 5),
  soreness      smallint check (soreness between 1 and 5),
  stress        smallint check (stress between 1 and 5),
  mood          smallint check (mood between 1 and 5),
  recorded_at   timestamptz not null default now(),
  unique (user_id, local_date)
);
```

Every item its own column and **no composite score column, ever**. Saw 2016
found subjective and objective recovery measures do not correlate; a composite
merges signals that move independently and hides which one moved. Any summary is
a view, computed at read time, and must name which item drove it.

`local_date` plus `recorded_at`: the date is the anchor that makes the series
comparable, the timestamp is how you find out it was actually filled in at 4pm.
A row whose `recorded_at` is more than N hours after local morning is reported
as off-anchor rather than silently trended.

```sql
create table checkins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('pre_session','post_session','spontaneous','prompted')),
  session_id  uuid references sessions (id) on delete set null,
  activity_id uuid references activities (id) on delete set null,
  energy      smallint check (energy between 1 and 5),
  feeling     smallint check (feeling between 1 and 5),
  note        text check (note is null or length(note) <= 1000),
  recorded_at timestamptz not null default now()
);
```

Unlimited per day. This is the "check in whenever" surface. It is deliberately
NOT unioned into `daily_readiness` for trending: the daily row is a fixed-time
measurement and these are events. Merging them makes the baseline depend on how
often someone happened to tap.

`prompted` versus `spontaneous` is kept because they mean different things. An
answer to "how's the Achilles?" measures the prompt; an unprompted report
measures salience.

```sql
create table symptom_episodes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body_region  text not null,
  side         text check (side in ('left','right','bilateral','n/a')),
  opened_on    date not null,
  closed_on    date,
  created_at   timestamptz not null default now(),
  check (closed_on is null or closed_on >= opened_on)
);

create table symptom_reports (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id       uuid not null references symptom_episodes (id) on delete cascade,
  instrument       text not null check (instrument in ('ostrc_o2','ostrc_h2','ostrc_o1')),
  recall_end       date not null,
  q1 smallint not null check (q1 between 0 and 3),
  q2 smallint not null check (q2 between 0 and 4),
  q3 smallint not null check (q3 between 0 and 4),
  q4 smallint not null check (q4 between 0 and 3),
  recorded_at      timestamptz not null default now(),
  unique (episode_id, recall_end)
);
```

`instrument` is a column because v1 and v2 score differently. Storing the raw
ordinals and deriving severity in a view follows the repo's rule that nothing
derived is stored, and it means a scoring correction is a view change rather
than a backfill of unrecoverable data.

**Blocked**: the item text and the exact v2 scoring must be verified against
Clarsen 2020, BJSM 54:390-6 before the form ships. The tables may land first.
The research doc records that the wording was reconstructed from the Oslo
group's R package because the research session's proxy blocked PMC and BMJ.

```sql
create table pain_checks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id  uuid references symptom_episodes (id) on delete set null,
  session_id  uuid references sessions (id) on delete set null,
  activity_id uuid references activities (id) on delete set null,
  phase       text not null check (phase in ('during','post','next_morning')),
  nrs_0_10    smallint not null check (nrs_0_10 between 0 and 10),
  captured_at timestamptz not null default now()
);

create table red_flags (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id             uuid references symptom_episodes (id) on delete set null,
  focal_bone_tenderness  boolean not null default false,
  night_or_rest_pain     boolean not null default false,
  pain_on_single_leg_hop boolean not null default false,
  pain_earlier_in_run    boolean not null default false,
  pain_in_daily_activity boolean not null default false,
  reported_at            timestamptz not null default now(),
  referred_at            timestamptz,
  referral_acknowledged_at timestamptz
);
```

Separate booleans, not a score. Any single one refers. A score invites a
threshold and the clinical literature does not provide one.

`phase = 'next_morning'` is a separate row with its own timestamp, not a column
on the run, because the next-morning criterion is a 24-hour delayed signal and
is what does the real work in both published pain-monitoring models.

```sql
create table report_prompts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('daily_readiness','ostrc_weekly','next_morning_pain','followup')),
  scheduled_for timestamptz not null,
  channel       text not null check (channel in ('push','in_app')),
  responded_at  timestamptz,
  skipped       boolean not null default false
);
```

This is the denominator. Without it there is no way to tell 91% adherence from
a drop-off, and adherence to self-reporting is the load-bearing assumption of
the entire injury half.

## Views

`v_ostrc_severity`: raw ordinals to 0-100 per the instrument version.
`v_symptom_episode_state`: per open episode, consecutive weeks reported,
current severity, whether substantial (Q1 = 3 OR Q2 >= 2 OR Q3 >= 2), and
whether it has been flagged three consecutive weeks.
`v_readiness_trend`: 7-day rolling mean per item against that user's own
baseline, with a `days_of_history` column so a consumer can refuse to interpret
under 28 days rather than being handed a confident number.

## PWA

One tap from Today to a check-in sheet, using the existing `Sheet` primitive
(`role="dialog"`, focus trap, ESC). Writes go through the existing outbox: these
are offline-first writes like sets, carry client UUIDs, and replay idempotently.

Prompts ride the existing Web Push infrastructure from `20260905050000`. Three
schedules: daily morning, weekly OSTRC, and next-morning-after-a-run (armed when
an activity or session lands the previous day).

Context block gains the latest readiness row and every open symptom episode,
following the `coach_memory` rule that memory which must be fetched is memory
that gets forgotten.

## Do not build

Any readiness score. Any injury risk column. Any passive alert. Any inference
from under 6 weeks of data. Any prompting of the OSTRC more often than weekly:
its recall period IS the measurement and more frequent prompting is off-label.

## Gate

1. 14 consecutive days of `daily_readiness` on a real phone, including two days
   where the app was offline at prompt time and the write queued.
2. Two weekly OSTRC responses; `v_ostrc_severity` reproduces the published
   scoring on a hand-worked example committed as a test fixture.
3. One `next_morning` pain check fired and answered the day after a real run.
4. One episode opened, extended across two weekly reports, and closed.
   `v_symptom_episode_state.consecutive_weeks` reads 2.
5. `report_prompts` yields a computable adherence rate; a skipped prompt is
   distinguishable from one never scheduled.
6. Item text verified against Clarsen 2020 and the citation recorded in the
   migration comment.
7. **Invariant**: full gate suite green. The check-in sheet is reachable from
   Today without displacing or delaying the Start button.

---

# E2 · The system knows where you are

State estimation. The read that makes everything downstream honest.

## Owns

`supabase/migrations/20260906030000_benchmark_efforts.sql`,
`supabase/functions/mcp-server/tools/training_state.ts` (new, + test),
`supabase/functions/mcp-server/lib/state.ts` (new, + test),
`supabase/functions/mcp-server/lib/handler.ts` (register only).

## The two-state model

`get_training_state` returns four groups and a `missing[]`. It never returns one
number, and it never returns a value it had to guess.

**Aerobic** (fast time constant): rolling 4 and 8 week moving hours; duration by
intensity zone against a versioned zone definition; recent benchmark efforts;
days since the last activity.

**Tissue tolerance** (slow time constant): longest run in the prior 30 days in
DURATION (this is the value E5's progression rule multiplies by 1.10); weighted
eccentric descent dose over 30 days; days since the last gap of 10 or more days;
weeks at or above the current weekly load.

**Strength**: current training maxes; e1RM trend; sessions per week over 4
weeks; weeks since the last session at or above 85% of training max (this is
what E5's floor rule reads).

**Subjective**: 7-day readiness trend per item against personal baseline, with
`days_of_history`; open symptom episodes with consecutive weeks; adherence from
`report_prompts`.

`missing[]` names each uncomputable value and why, following the precedent of
`resolveTrainingMaxes` returning `unresolved_pct` rather than refusing. A caller
must be able to distinguish "descent dose is 0" from "descent dose is unknown".

## Eccentric descent dose

Total descent is the wrong unit: 500 m descended walking is not 500 m descended
at 4 m/s. Two implementations of the same column:

- **Coarse (E2)**: from `activities.descent_m` and Strava per-lap `avg_grade`
  where available, weighted by lap mean speed. `dose_source = 'summary'`.
- **Fine (E7)**: from FIT grade-band splits. `dose_source = 'fit'`.

The column and the rules that read it do not change between the two. Only
precision does. This is what stops E5 depending on E7.

## `benchmark_efforts`

```sql
create table benchmark_efforts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  activity_id    uuid not null references activities (id) on delete cascade,
  benchmark_key  text not null,
  source         text not null check (source in ('strava_segment','route_match','manual')),
  elapsed_s      int not null check (elapsed_s > 0),
  avg_hr         smallint check (avg_hr between 20 and 250),
  avg_power_w    numeric(6,1),
  avg_cadence    numeric(5,1),
  performed_at   timestamptz not null,
  unique (activity_id, benchmark_key)
);
```

This exists because submaximal HR and RPE at a fixed benchmark effort is the one
objective fatigue marker with functional-overreaching evidence behind it, and
because the user already generates the data without meaning to. Probing the live
account found repeated Strava segment efforts carrying `avg_hr`, `avg_watts` and
`avg_cadence`; a weekly Twin Peaks run is a free repeated-measures test.

**Direction trap, encoded as a comment on the view and a test.** In functional
overreaching the early markers are LOWER heart rate at fixed submaximal
intensity and FASTER heart rate recovery, alongside higher RPE at the same load.
Any rule that reads falling HR at a fixed effort as improving fitness is wrong
in exactly the case that matters. `v_benchmark_series` therefore returns HR
alongside the RPE for the same session and refuses to interpret either alone.

## Do not build

A composite. A prediction. A recommendation. This phase reports state.

## Gate

1. Returns a complete state vector for a real user.
2. With history truncated to 3 weeks, every affected value appears in `missing`
   and none is returned as zero. Test with a fixture, not by hand.
3. **The falsifiable one.** Replayed across the real 2026-07-26 to 2026-08-21
   gap, aerobic and tissue-tolerance states move on visibly different
   timescales, with aerobic recovering first. Committed as a test over a
   fixture built from the real history. If they move together the model is
   wrong and this phase is not done.
4. `v_benchmark_series` yields a usable series across at least 8 repetitions of
   one segment.
5. A test asserts that falling benchmark HR with rising RPE is not reported as
   improving fitness.
6. **Invariant**: full gate suite green.

---

# E3 · The target and the constraints

The facts that cannot be derived. Mostly a conversation, stored once.

## Owns

`supabase/migrations/20260906040000_events_constraints.sql`,
`supabase/functions/mcp-server/tools/event.ts` (new, + test),
`supabase/functions/mcp-server/tools/constraints.ts` (new, + test).

## Schema

```sql
create table events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  event_date    date not null,
  priority      text not null default 'A' check (priority in ('A','B','C')),
  distance_m    numeric(10,1) check (distance_m > 0),
  ascent_m      numeric(8,1)  check (ascent_m >= 0),
  descent_m     numeric(8,1)  check (descent_m >= 0),
  technicality  smallint check (technicality between 1 and 5),
  surface       text check (surface in ('road','mixed','trail','technical_trail')),
  altitude_max_m numeric(6,1) check (altitude_max_m >= 0),
  expected_temp_c numeric(4,1),
  cutoff_s      int check (cutoff_s > 0),
  aid_spacing_km numeric(5,1) check (aid_spacing_km > 0),
  crew_allowed  boolean,
  poles_allowed boolean,
  training_plan_id uuid references training_plans (id) on delete set null,
  superseded_at timestamptz,
  created_at    timestamptz not null default now()
);
```

**`descent_m` is separate from `ascent_m` and is the reason this table exists.**
The survey found no platform models elevation loss: Runna's terrain field is a
four-value enum describing where the user lives, Uphill Athlete counts gain
only, Vert.run's Mountain Index is gain-only density. Descent is what produces
about 40% knee-extensor strength loss at the finish of a mountain ultra, and it
is what E5's eccentric block is dosed against. A single `vert` column would
throw away the differentiator.

```sql
create table athlete_constraints (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  days_available      text[] not null default '{}',
  weekday_ceiling_min int check (weekday_ceiling_min > 0),
  long_day_ceiling_min int check (long_day_ceiling_min > 0),
  long_day            text,
  strength_floor_sessions smallint not null default 1 check (strength_floor_sessions between 0 and 7),
  strength_floor_pct_tm numeric(5,2) not null default 85 check (strength_floor_pct_tm between 0 and 200),
  min_separation_hours numeric(4,1) not null default 6 check (min_separation_hours >= 0),
  has_gym             boolean not null default true,
  has_trail_access    boolean not null default true,
  has_treadmill       boolean not null default false,
  notes               text check (notes is null or length(notes) <= 1000),
  effective_from      date not null default current_date,
  created_at          timestamptz not null default now()
);
```

`strength_floor_pct_tm` defaults to 85 because that is where the evidence puts
it: strength is maintained up to 32 weeks on one session and one set per week
PROVIDED relative load holds. This column is how "strength does not get cut"
stops being a preference and becomes a constraint the generator cannot violate.

`min_separation_hours` defaults to 6, the number equivalent to 24 hours for
strength outcomes, with 3 the molecular floor. It is a column rather than a
constant because this user's own log shows lifting at 08:07 and running at
09:10 as routine, and a rule he will not follow is worse than a rule he sets
himself with the cost stated.

`training_environments` is separate from `events` and holds where the athlete
actually trains: typical vert per week available, altitude, temperature. TriDot
is the only surveyed platform that separates these, and conflating them is
precisely the defect that makes Runna's single terrain enum useless.

## Calendar-derived disruption proposals

Probing the live Google Calendar found the signal is real but thin: recurring
work meetings dominate, and the one travel signal in four months was an all-day
multi-day hold. So the tool proposes and never assumes. "I see a multi-day hold
Nov 11 to 15, is that a trip?" is confirmed once and stored. Silent inference is
worse than asking, because a wrong fact you cannot see is a wrong plan you
cannot debug.

## Gate

1. A real 50K encoded with `ascent_m` and `descent_m` both non-null and
   distinct.
2. `get_training_state` plus the event is sufficient to name every rule from the
   research doc that will apply, with none requiring an absent value. Assert by
   a test that enumerates the rule set and checks its inputs resolve.
3. An intake tool called with an incomplete event returns a named missing-field
   list and writes nothing. No partial writes.
4. Every calendar-derived fact was proposed and confirmed before storage;
   a test asserts the tool cannot write an unconfirmed inference.
5. **Invariant**: full gate suite green.

---

# E4 · Endurance days on the calendar

The highest-risk phase, because it is the first one that changes what the
existing app renders. Two current behaviours break silently if this is done
carelessly; both are fixed here, in the same migration that causes them.

## Owns

`supabase/migrations/20260906050000_planned_efforts.sql`,
`supabase/functions/mcp-server/tools/update_planned_workout.ts`,
`pwa/src/screens/Today.tsx`, `pwa/src/screens/Plan.tsx`,
`pwa/src/lib/data.ts` (DONE derivation), `pwa/src/lib/plan.ts` (+ tests),
`pwa/src/components/EffortEditor.tsx` (new).

## The two breakages, stated first

**`exercise_count` counts only prescriptions.** A day holding a run and no lift
has `exercise_count = 0`, and the existing rule renders that as a DRAFT. The
rule exists because an empty dated day accused someone of skipping a session
nobody programmed. A programmed run day reading as a draft is the same bug with
the sign flipped: the day IS programmed and the app says it is not.

Fix: rename the concept, not just the sum. `v_plan_workouts` gains
`entry_count` (prescription rows plus effort rows) and keeps `exercise_count`
unchanged so existing selects are unaffected, per the additive rule that
`20260905000000` established. The PWA's draft check moves to `entry_count`.

**DONE reads a session with `ended_at not null`.** A run has no session, so a
completed run day reads as MISSED. Fix in `pwa/src/lib/data.ts`: a day is done
when it has a session with `ended_at not null` **or** a non-discarded activity
linked to it. `v_training_days` provides the union so both the PWA and the MCP
server answer identically, the way `app_tz` made calendar days answer
identically across the two paths.

Both of these get a test that fails if the fix is reverted.

## `time_of_day`, and why it is one column rather than a table

A day holding a lift and a run has no total order across two tables. And E5
cannot enforce the 6-hour separation rule against a date-keyed day. Both are the
same missing fact.

```sql
alter table prescriptions   add column time_of_day time;
-- planned_efforts carries the same column from birth.
```

Ordering within a day is `(time_of_day nulls last, kind, position)`. Consecutive
rows sharing a `time_of_day` are a block, which is the repo's existing adjacency
idiom (`section`, `superset_group`, and the ramp rule all work this way) rather
than a fourth grouping mechanism, which CLAUDE.md requires a decision entry to
introduce.

Nullable, and null means unstated rather than midnight. A plan that does not say
when is a plan the separation rule reports as unverifiable, not one it rejects.

Rejected alternative: two `planned_workouts` rows per date, one per session.
That breaks `unique (program_id, day_index)`, breaks the one-row-per-cell
assumption in the week strip, and forces `v_plan_workouts` to change shape.
One nullable column against a schema change that touches every plan read.

## `planned_efforts`

```sql
create table planned_efforts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  planned_workout_id uuid not null references planned_workouts (id) on delete cascade,
  position           int not null check (position >= 0),
  time_of_day        time,
  sport              text not null default 'run',
  step_kind          text not null default 'active'
                       check (step_kind in ('warmup','active','rest','cooldown')),
  duration_type      text not null check (duration_type in ('time','distance','open')),
  duration_s         int check (duration_s > 0),
  distance_m         numeric(10,1) check (distance_m > 0),
  target_type        text check (target_type in ('none','hr_zone','pace','power','effort','grade')),
  target_low         numeric(8,2),
  target_high        numeric(8,2),
  vert_m             numeric(8,1) check (vert_m >= 0),
  descent_m          numeric(8,1) check (descent_m >= 0),
  terrain            text check (terrain in ('road','mixed','trail','technical_trail','treadmill','track')),
  repeat_group       smallint check (repeat_group between 1 and 9),
  repeat_count       smallint check (repeat_count between 1 and 99),
  notes              text check (notes is null or length(notes) <= 500),
  unique (planned_workout_id, position),
  check ((duration_type = 'time'     and duration_s is not null)
      or (duration_type = 'distance' and distance_m is not null)
      or  duration_type = 'open'),
  check (target_high is null or target_low is null or target_high >= target_low)
);
```

The shape is `workout -> step -> repeat-block(steps)` because TrainingPeaks
structured JSON, Zwift `.zwo`, Garmin's FIT `workout_step` and the intervals.icu
text DSL all reduce to exactly that and none nests deeper than one repeat level.
Matching it costs nothing now and buys a `.fit` export to a watch later.
`repeat_group` plus adjacency expresses the repeat the way `superset_group`
already expresses a superset; FIT itself encodes repeats as a step that jumps
back rather than by nesting, so one level is the ceiling everywhere.

`descent_m` appears here too, because a prescribed long run on a loop with
1200 m of descent is a different session from one with 200 m, and the eccentric
scheduler in E5 needs to see the prescription, not just the result.

`notes` is the coach's cue and only that, the same rule `prescriptions.notes`
carries: never parse commentary, never a date, never an unresolved percentage.

## `blocks`

```sql
create table blocks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  phase_id        uuid references plan_phases (id) on delete set null,
  event_id        uuid references events (id) on delete set null,
  name            text not null,
  starts_on       date not null,
  ends_on         date not null,
  pattern         jsonb not null,
  progression     jsonb not null,
  constraints     jsonb not null,
  generated_at    timestamptz not null default now(),
  confirmed_at    timestamptz,
  superseded_by   uuid references blocks (id) on delete set null,
  superseded_at   timestamptz,
  check (ends_on >= starts_on)
);
```

`planned_workouts` gains a nullable `block_id`. A block is what `confirm_block`
confirms and what `replan` supersedes. Storing the `pattern`, `progression` and
`constraints` that generated it is what makes re-derivation possible: a block
that cannot say how it was produced cannot be regenerated against a changed
state, which is the whole difference between a planning service and a
conversation with a database.

Unconfirmed on write, like programs and training plans. Superseded, never
deleted.

## Renderers

Today and the plan editor both render efforts, and **both apply the same rules**.
The precedent is already in CLAUDE.md: the MAIN WORK label appears only once a
day has a named part, and the plan editor and session screen must apply that
rule identically or the two describe different days. Same obligation here for
time-of-day blocks, ramps and repeats.

`update_planned_workout` learns efforts and replaces a day's efforts wholesale,
exactly as it already replaces prescriptions, for the same reason: order,
repeats and time blocks are all adjacency, so a per-row patch would let a caller
tear a repeat in half without naming it. New rows are parked above the old and
land after the delete, since PostgREST has no transactions and a visible
duplicate beats an emptied day.

## Gate

1. A hand-authored week containing an interval session (warmup, 6 x 3 min with
   90 s float, cooldown), a long run with a vert and descent target, and two
   strength days renders correctly on Today and in the plan editor, and the two
   agree.
2. That week round-trips through `update_planned_workout` without losing order,
   repeat grouping, or `time_of_day`.
3. **Regression, must fail if reverted**: a day holding only efforts does NOT
   render as a draft.
4. **Regression, must fail if reverted**: a day whose only completion is an
   activity renders DONE, and a day whose activity is discarded does not.
5. A day with logged work against it is refused, matching the existing trigger.
6. Deleting the endurance half of a mixed day leaves the strength half intact,
   and vice versa.
7. `exercise_count` returns exactly what it returned before this migration for
   every pre-existing day. Assert against a fixture captured before the change.
8. **Invariant**: full gate suite green; Today renders with an endurance layer
   that is empty, half-populated and fully populated.

---

# E5 · The block generator

The tool the project is for. It arrives fifth because only now does it have
inputs.

## Owns

`supabase/functions/mcp-server/tools/draft_block.ts` (new, + test),
`supabase/functions/mcp-server/lib/expand.ts` (new, + test),
`supabase/functions/mcp-server/lib/rules.ts` (new, + test),
`supabase/functions/mcp-server/tools/confirm_block.ts` (new).

## Why a pattern, not sixty days

`update_planned_workout` writes one day; twelve weeks is roughly sixty calls and
the model drifts, duplicates and runs out of turn. `upsert_program` writes a
whole program as one blob and refuses to touch a confirmed one, which is how a
real user ended up with two live plans. Neither is the right unit.

A block is a weekly pattern plus a progression rule plus explicit exceptions. If
the surface makes the model emit sixty days, it emits sixty days badly. If it
emits a pattern the server expands, the model only has to be right about the
shape, and consistency is free.

**The honest risk, and the measurable escape hatch.** A pattern language rigid
enough to validate may be too rigid to express real coaching. So `overrides[]`
is a first-class input, and the acceptance test is: encode the athlete's last
real coached block. If it needs more than three overrides, the language is too
rigid and must grow before this phase ships. That is a falsifiable check on the
core design bet rather than a hope.

## Inputs

```
draft_block({
  phase_id, event_id, weeks,
  pattern:     { mon: 'strength_lower', tue: 'quality', thu: 'medium',
                 sat: 'long', sun: 'easy' },
  progression: { kind: 'step_3_1', long_run: { start_min, cap_min },
                 weekly_volume_pct, descent_progression },
  constraints: { from athlete_constraints, overridable per call },
  overrides:   [ { date, replace_with | skip | note } ]
})
```

`progression.kind` is a closed set (`linear`, `step_3_1`, `flat`,
`reverse_taper`), each parameterised. `plan_phases.progression` prose is
GENERATED from the rule, not authored beside it. Two representations that can
disagree is how `replan` degrades into "ask the model again", which is where
this started.

## The constraint checker

`lib/rules.ts` runs against the generator's own output and is the phase's real
deliverable. Every rule cites its tag from the research doc; only STRONG and
MODERATE rules may block, CONVENTION rules warn.

| Rule | Behaviour | Tag |
| --- | --- | --- |
| Long run <= 110% of longest run in prior 30 days, in DURATION | block | MODERATE |
| Weekly volume increase > 30% | warn | MODERATE |
| Hard descent exposure every 10 to 14 days from 6 to 8 weeks out | block | MODERATE |
| 5 to 9 days between high-eccentric sessions | block | STRONG |
| Eccentric block ends >= 3 weeks before event | block | MODERATE |
| >= 1 lower-body strength session/week at >= `strength_floor_pct_tm` | block | STRONG |
| Strength volume may fall; strength LOAD may not | block | STRONG |
| Separation >= `min_separation_hours`; never < 3 | block if time_of_day known, warn if null | MODERATE |
| No quality run within 24 h after heavy lower body; 48 h after eccentric | block | MODERATE |
| Never strength on the long-run day | block | CONVENTION |
| Taper: volume -41 to -60%, intensity and frequency held, <= 21 days | block | STRONG |
| Progress load OR vertical in a week, never both | warn | CONVENTION |
| Heat block: 7 to 14 exposures ending <= 2 weeks out | block if `expected_temp_c` set | STRONG |
| Altitude block: 3 to 4 weeks if `altitude_max_m` >= 2000 | warn | MODERATE |
| Gut block: 4 to 6 weeks of fuelled long runs | warn | MODERATE |
| Development phase label requires >= 10 weeks at >= 2 strength sessions/week | block the LABEL | STRONG |

The strength floor deserves its own note because it is the one constraint the
athlete actually stated. Intensity is the invariant and volume is the free
variable: strength holds up to 32 weeks on one session and one set per week
provided relative load is held. So when running volume rises the generator cuts
sets and frequency toward the floor and **never** touches `load_pct_tm`. A test
asserts that no generated block anywhere reduces prescribed load percentage in
response to running volume.

## Two interference directions, encoded separately

Chronically, endurance blunts strength and strength does not blunt VO2max, so
strength is scheduled generously. Acutely, lifting degrades the NEXT run's
quality for 24 to 48 hours, so quality runs are protected. These are two rules
with opposite subjects. A single interference penalty gets one of them wrong,
and the test suite contains a case for each direction that fails if they are
collapsed.

## Backward solving

Modifier blocks are placed by solving backward from `events.event_date`: taper,
then eccentric block ending 3 weeks out, then heat ending 2 weeks out, then
altitude, then gut riding on existing long runs. Conflicts are reported with the
binding constraint named, not silently resolved by precedence.

## Output

A week-shaped summary plus counts, not sixty days of JSON, because the full
expansion back into the model burns the context the conversation needs. Full
detail is behind `get_program`. Each week carries the rules that produced it, so
the explanation to the athlete is derived rather than narrated.

## Unreachable targets

Given a target the constraints cannot reach, the tool returns **what is
reachable** with the binding constraint named. It does not refuse, and it does
not quietly emit a plan that violates a rule. "12 weeks to a 50K from 25 km/wk"
has an answer, and the answer is a description of the gap.

## Gate

1. A generated 12-week block satisfies every blocking rule, proven by
   `lib/rules.ts`, not by reading it.
2. **Each rule has a test that fails when the rule is removed.** A checker whose
   rules are untested is a checker that silently stops checking.
3. The athlete's last real coached block encodes in <= 3 overrides. If not, the
   pattern language grows before this ships.
4. Given an unreachable target, output names the binding constraint and
   describes what is reachable.
5. A test asserts no generated block ever reduces `load_pct_tm` in response to
   running volume.
6. A test per interference direction, each failing if the two are collapsed.
7. Output contains no predicted finish time and no injury-risk claim. Assert by
   string search over the generated summary in a test.
8. **Invariant**: full gate suite green.

---

# E6 · The plan meets reality

The differentiator. Every platform surveyed fails here: no retroactive logging,
no backdating an adjustment, plans that never change.

## Owns

`supabase/migrations/20260906060000_disruptions.sql`,
`supabase/functions/mcp-server/tools/replan.ts` (new, + test),
`supabase/functions/mcp-server/lib/triage.ts` (new, + test),
`supabase/functions/coach/prompt.ts` (triage rules block).

## `disruptions`

```sql
create table disruptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('travel','illness','injury','life','deliberate_rest')),
  starts_on    date not null,
  ends_on      date,
  severity     smallint check (severity between 1 and 5),
  note         text check (note is null or length(note) <= 500),
  recorded_at  timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
```

`starts_on` may be in the past and `recorded_at` is separate from it. That gap
is the entire point: the consistent complaint about existing tools is the
inability to record a gap that already happened.

## `replan`

Re-derives forward from a date, keeping the objective and the remaining phases,
re-solving with fewer weeks and current state. It is not
`update_planned_workout` in a loop; it re-runs the arithmetic.

Rules it must honour:

- Only touches days with nothing logged against them, matching the existing
  `before delete` trigger.
- Supersedes the old block rather than deleting it, following
  `training_plans.superseded_at`.
- **Return from a gap is gated on the tissue-tolerance state, not the aerobic
  one.** This is the finding that changed the design. After 26 days off, VO2max
  is down 4 to 8% and comes back in one to two weeks, but bone stress injuries
  appear 3 to 4 weeks after a load shift and tendon lags muscle by 6 to 12
  weeks. The engine is ready first and the structures are ready last. A single
  fitness number reflects the fast variable and says "ramp".

## Triage

`lib/triage.ts`, driven by E1's data:

- Substantial OSTRC week (Q1 = 3 OR Q2 >= 2 OR Q3 >= 2) proposes a plan
  modification, not a nudge.
- Same region three consecutive weeks recommends clinician assessment
  regardless of severity. Persistence, not intensity, is the overuse signature.
- Week-to-week severity change below the individual SDC of 35 produces no
  escalation, even though the group MIC is 18.5. For one athlete the SDC exceeds
  the MIC, so a delta below it is measurement noise.
- Post-run pain gate: <= 2/10 during and back to baseline within 24 h
  progresses; > 3/10 or next-morning symptoms repeats the previous stage.
  Tendinopathy exception: <= 5/10 if baseline by next morning and not climbing
  week on week.
- Any single bone-stress red flag stops running and refers same day. Not a
  combination, not a score.
- REDs indicators refer to a physician. The tool does not stratify; CAT2 is
  physician-led at the diagnostic step.

## Passive signals

Annotate a report the athlete made. Never raise one. There is no prospective
evidence that cadence, GCT asymmetry or vertical oscillation detect emerging
injury before self-report; ML models run near AUC 0.52; and at roughly 7.7
injuries per 1000 hours any daily passive alarm is overwhelmingly false
positives.

## Gate

1. Replaying the real 26-day gap produces a restart gated on tissue tolerance,
   with the first long run at or below 110% of the longest in the prior 30 days.
2. A disruption recorded three weeks after the fact re-plans correctly and
   mutates no day already trained.
3. A substantial OSTRC week produces a visible plan proposal.
4. A single red flag triggers referral without requiring a second.
5. **Fabricate a large cadence drop and assert silence.** No passive signal
   alone produces any user-visible output.
6. A severity delta of 30 produces no escalation; a sustained three-week
   presence does.
7. **Invariant**: full gate suite green.

---

# E7 · Deep session data

Optional, deliberately late. The most objective, most expensive and most
seductive data in the stack, and the evidence says the subjective baseline
matters more.

## Owns

`supabase/migrations/20260906070000_activity_detail.sql`,
`supabase/functions/mcp-server/tools/parse_fit.ts` (new, + test),
`scripts/fit-fixtures/` (a real long run and a real trail run, committed).

## Selection rule

Collect FIT for **repeated** runs, not important ones. Comparability comes from
repetition, and the one evidence-backed objective fatigue marker is a fixed
benchmark effort. Designate two or three fixtures: one climb, one long route,
one descent.

## Derived, never warehoused

No per-second streams. Parse once, store roughly thirty numbers:

```sql
create table activity_detail (
  activity_id   uuid primary key references activities (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  quartiles     jsonb not null,   -- 4 x {pace, hr, cadence, gct_ms, vert_osc_mm, power}
  grade_bands   jsonb not null,   -- 5 x {band, time_s, pace, hr, cadence, gct_ms}
  gct_balance   jsonb,            -- distribution, not a mean
  eccentric_dose numeric(10,2),
  dose_source   text not null check (dose_source in ('summary','fit')),
  parsed_at     timestamptz not null default now()
);
```

Grade bands: below -8%, -8 to -3, -3 to +3, +3 to +8, above +8.

**Quartiles are the ultra-specific measurement.** Summary statistics cannot show
that ground contact time rose 8% and cadence fell 4 spm in the last hour of a
four-hour run. That decay curve is available nowhere else and maps onto the gap
two independent research lanes found: nobody models durability.

`eccentric_dose` overwrites E2's coarse value and flips `dose_source` to `'fit'`.
The column and every rule reading it are unchanged; only precision moves.

## No pipeline

The file is attached in chat; `parse_fit` reads it and writes. Promote to
automatic ingestion only if the manual path is used weekly. Parse with
`fitdecode` semantics; in Deno, prefer an `npm:` FIT parser over `jsr:` per the
sandbox constraint.

## Gate

1. Within-session decay visible across quartiles of a real long run fixture.
2. Grade-band splits separate descending from climbing on a real trail fixture.
3. Storage under 1 KB per activity.
4. `eccentric_dose` recomputed from FIT is within a stated tolerance of the E2
   coarse value on the same activity, or the discrepancy is explained. If the
   two disagree wildly the coarse estimate was wrong and E5's descent rules were
   being gated on noise.
5. **Invariant**: full gate suite green.

---

# E8 · The coach learns the endurance layer

Without this, E0 to E7 is a schema and a generator with nobody driving them.

## Owns

`supabase/functions/coach/prompt.ts`,
`supabase/functions/coach/index.ts` (connector `configs` only),
`pwa/src/lib/coachContext.ts`.

## Context block

Gains, following the rule that memory which must be fetched gets forgotten:

- A STATE line: aerobic and tissue-tolerance summary with their timescales named
  separately, never merged.
- Latest `daily_readiness` and its `days_of_history`.
- Open symptom episodes with consecutive weeks and substantial status.
- The next event, days out, and the current block's phase.

Everything else stays behind a tool call. The context block is for what must
never be forgotten, not for everything that could be relevant.

## Tools disabled at the connector

`draft_block`, `confirm_block` and `replan` follow the `set_training_plan`
precedent: **available in Claude Desktop, off for the in-app coach.** Strategy
is set at a desk with time to think; tactics are set between sets. A twelve-week
block generated mid-session from a phone is exactly the decision that should not
be made mid-session from a phone.

`update_planned_workout` stays on for the in-app coach, because adjusting
tomorrow is a tactical act.

This is not a prompt instruction. Turning a tool off converts "the prompt says
ask first" into something an injected instruction cannot reach, which is the
same reasoning that disabled `update_exercise` for the coach.

## Prompt rules

- Fit every day written to the current phase AND the current block's
  progression rule, questioning a request that contradicts either.
- Never state a predicted finish time. Never claim injury-risk reduction from
  strength training. Never name an overtraining syndrome.
- When a red flag is present, say so and refer, before anything else in the
  turn.
- Report the two states separately and never average them.
- Say which rule produced a recommendation, citing the research doc's tag, so
  the athlete can tell a STRONG rule from a CONVENTION.
- A percentage or a pace with no resolvable anchor is reported as unresolved,
  the way `unresolved_pct` already works, and never invented.

## Gate

1. Asked to plan a 50K in the in-app coach, the coach explains that block
   generation happens in Desktop and does what it can tactically. It does not
   hallucinate the tool.
2. Asked for a finish-time prediction, it declines and says why in one sentence.
3. With an open red flag in context, the referral leads the turn.
4. A generated day that contradicts the current phase is questioned, not
   written.
5. **Invariant**: full gate suite green, coach eval suite green.

---

# E9 · Evals and deploy

The phase that decides whether any of this works.

## Owns

`scripts/coach-eval/cases/endurance-*.json` (new),
`scripts/planning-eval/` (new), `docs/deploy.md`.

## Planning eval

The coach eval already replays real transcripts against a real MCP server with
end-state checks. The planner needs the same treatment, but its assertions are
different: a plan is checkable against `lib/rules.ts` rather than against a
transcript.

Cases, each a fixture of state plus an event, asserted on the generated block:

1. **Cold start.** 25 km/wk, 12 weeks, mountain 50K. Must not ramp on the
   aerobic state; must gate on tissue tolerance.
2. **The real gap.** Replay 2026-07-26 to 2026-08-21 and re-plan from
   2026-08-21. Must produce a restart, not a continuation.
3. **Unreachable.** 6 weeks, 2500 m descent, from a 25 km/wk base. Must name the
   binding constraint and describe what is reachable.
4. **Strength floor under pressure.** Peak running volume week. Must cut sets,
   never load.
5. **Descent scheduling.** 2000 m descent event. Must place eccentric exposures
   every 10 to 14 days ending 3 weeks out.
6. **Heat.** Event at 30 C. Must place a 7 to 14 exposure block ending within 2
   weeks.
7. **Mid-block injury.** Substantial OSTRC in week 5. Must propose a
   modification and must not silently continue.
8. **Red flag.** Focal bone tenderness reported. Must stop and refer.
9. **Same-day stacking.** Constraints with `min_separation_hours = 1` (this
   user's actual behaviour). Must warn with the cost stated, and must still
   produce a plan rather than refusing.

Each case asserts on rule output, not on prose, so the eval does not become a
test of phrasing.

## Deploy

`docs/deploy.md` gains a section per new function (`endurance-sync`) and the
migration ordering. Two constraints carried from the 2026-09-05 round: the
Supabase MCP `deploy_edge_function` takes file contents inline, so a function
that outgrows that door needs the orphan-branch bundle trick already documented;
and `\u` escapes must stay out of anything passing through that transport,
because the JSON layer decodes them into raw characters.

## Gate

1. All nine planning-eval cases pass.
2. Coach eval, including the new endurance cases, passes at no worse than the
   existing baseline.
3. `docs/deploy.md` walked end to end on a real deploy, with the recorded sha
   and `/health` verified.
4. **Invariant**: full gate suite green.

---

# Sequencing

```
E0 activities ─┐
               ├─► E2 state ─┐
E1 subjective ─┘             ├─► E5 generator ─► E6 adaptation ─► E8 coach ─► E9 eval
               E3 target ────┤        ▲
               E4 calendar ──┘        │
                                 E7 FIT (refines E2's dose; never blocks)
```

E0 and E1 share no tables and run in parallel. **E1 starts first regardless of
everything else**, because subjective data only accrues forward and a week
without it cannot be recovered.

E4 can be built any time but is pointless before E3. E7 blocks nothing.

If worktrees are used as in the 2026-09-05 round, the clean split is: A owns E0
plus E7 (ingest and parsing), B owns E1 (capture, PWA-heavy), C owns E3 plus E4
(schema and renderers). E2, E5, E6, E8, E9 are sequential and single-owner
because each depends on the last.

# What would make this plan wrong

Recorded so the failure is recognisable rather than surprising.

**Descent is not in the upstream data.** The whole differentiator assumes
`descent_m` arrives populated. E0's gate checks this deliberately early. If
intervals.icu does not carry it, the fallback is computing it from the altitude
stream, and if that is absent too, the descent rules degrade to prescriptions
only and the eccentric block cannot be verified against what was actually done.

**The pattern language is too rigid.** E5's three-override test is the check. If
a real coached block needs ten overrides, the weekly-pattern bet was wrong and
the unit should be the week authored directly, with the server validating rather
than generating.

**Adherence to self-reporting does not hold for one person.** The 82 to 96%
figures come from supervised cohorts with a researcher attached. A solo athlete
with a push notification is a different situation. `report_prompts` exists to
detect this within four weeks rather than discovering it at month six. If daily
adherence falls below about 50%, drop to the weekly OSTRC alone and treat the
daily panel as optional, because a sparse subjective series is worse than none:
it invites trend-reading on noise.

**The two-state model is unfalsifiable as specified.** E2's gate asserts the
states move on different timescales across a real gap, which is the strongest
check available, but "different timescales" needs a number before that test can
be written. Set it when the fixture is built, from the athlete's own recovery
after 2026-08-21, and record it in the test rather than in prose.

**intervals.icu disappears.** One person, free, no SLA. FIT parsing (E7) is the
fallback and is the reason E7 exists at all rather than being pure enrichment.

# Explicitly out of scope

Race-day execution, pacing plans and post-race recovery protocols. The system
gets an athlete to a start line prepared; what happens after the gun is a
different product. Revisit only once E9 has run a full build cycle.
