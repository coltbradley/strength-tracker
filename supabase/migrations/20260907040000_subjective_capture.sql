-- E1 of the endurance layer: the athlete answers.
--
-- This is the phase that matters most and looks least impressive. Saw, Main and
-- Gastin (BJSM 2016, 56 studies) found subjective wellbeing tracked acute and
-- chronic load with SUPERIOR sensitivity and consistency to objective measures,
-- and that the two categories generally did not correlate. The cheapest data to
-- collect is the best signal, and it only accrues forward: a week without it
-- cannot be recovered, which is why this ships early rather than after the
-- planner it feeds.
--
-- Three cadences, three tables, and they are deliberately not one table with a
-- `kind` column. They measure different things on different clocks, and merging
-- them produces a pleasant UI over uninterpretable data.

-- 1. ANCHORED DAILY -----------------------------------------------------------
--
-- One row per local date, taken in the morning before training. This is the row
-- that TRENDS, and its value comes from being taken at a consistent time
-- against the person's own baseline.
create table daily_readiness (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The DEVICE's date, not the server's. The phone travels with the lifter and
  -- this repository already decided the client owns "what day is it" (see
  -- useLocalToday); a readiness row filed against a UTC date would land on the
  -- wrong day for anyone training in the evening west of Greenwich.
  local_date    date not null,
  sleep_hours   numeric(3,1) check (sleep_hours between 0 and 24),
  sleep_quality smallint check (sleep_quality between 1 and 5),
  fatigue       smallint check (fatigue between 1 and 5),
  soreness      smallint check (soreness between 1 and 5),
  stress        smallint check (stress between 1 and 5),
  mood          smallint check (mood between 1 and 5),
  -- Measurements that belong to the same moment as the panel. Bodyweight
  -- already exists on `sessions`, but only on days somebody lifted, which makes
  -- it useless as a trend; resting HR is here for people with no wearable to
  -- read it off. Both optional, like everything else on this row.
  bodyweight_kg numeric(5,2) check (bodyweight_kg > 0),
  resting_hr    smallint check (resting_hr between 20 and 150),
  -- Context that EXPLAINS a bad reading rather than scoring it. Without these a
  -- poor day looks like accumulated training load when it was a late flight and
  -- a bottle of wine, and the whole value of a subjective series is that it
  -- distinguishes those. Alcohol in particular is the largest single confounder
  -- of resting HR and HRV, which is why it is here and not a judgement.
  illness       boolean,
  alcohol_units numeric(4,1) check (alcohol_units >= 0),
  travel        boolean,
  note          text check (note is null or length(note) <= 1000),
  -- User-defined items. See readiness_fields below for the rule that governs
  -- what may be done with these.
  custom        jsonb not null default '{}'::jsonb,
  -- Separate from local_date on purpose: the date is the anchor that makes the
  -- series comparable, the timestamp is how you find out it was actually filled
  -- in at 4pm. A row far from local morning is REPORTED as off-anchor rather
  -- than silently trended beside rows that were not.
  recorded_at   timestamptz not null default now(),
  unique (user_id, local_date)
);

comment on table daily_readiness is
  'One anchored morning reading per local date. Every item is its own column '
  'and there is NO composite score, ever: subjective and objective recovery '
  'measures do not correlate, so a composite merges signals that move '
  'independently and hides which one moved. Any summary is a view.';

-- Client-generated ids, like every other client write here, so a replay through
-- the outbox is idempotent rather than a duplicate day.
create index idx_readiness_user_date on daily_readiness (user_id, local_date desc);

alter table daily_readiness enable row level security;
create policy readiness_select on daily_readiness
  for select to authenticated using (user_id = auth.uid());
create policy readiness_insert on daily_readiness
  for insert to authenticated with check (user_id = auth.uid());
-- Updatable, unlike a set: this is a self-report someone may correct within the
-- day, the `sessions.notes` mutability class rather than the `sets` one.
create policy readiness_update on daily_readiness
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 1b. CUSTOM ITEMS, AND THE LINE THEY MAY NOT CROSS ---------------------------
--
-- The fixed columns above are the core because validated instruments (POMS,
-- RESTQ-Sport, DALDA) hold up psychometrically and the short custom wellness
-- sliders most apps ship do not. That is an argument for keeping the core
-- fixed, not for refusing everything else: somebody tracking a knee, a
-- caffeine habit or a commute has a real reason to.
--
-- So the line is drawn at what a value is ALLOWED TO DO rather than at whether
-- it may exist. A custom item may be recorded, charted, and read by the coach
-- as context. It may NEVER gate a rule -- no plan modification, no triage
-- escalation, no constraint in the block generator may branch on one. This is
-- the same discipline the research doc applies to its own findings, where only
-- STRONG and MODERATE evidence may block and everything weaker may only be
-- reported.
create table readiness_fields (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The key used inside daily_readiness.custom. Constrained to something that
  -- survives being a JSON key and a chart label without quoting.
  key        text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label      text not null check (length(trim(label)) between 1 and 60),
  kind       text not null check (kind in ('scale_1_5','number','boolean','text')),
  -- For 'number' only; ignored otherwise.
  min_value  numeric(8,2),
  max_value  numeric(8,2),
  unit       text check (unit is null or length(unit) <= 20),
  position   int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, key),
  check (max_value is null or min_value is null or max_value >= min_value)
);

comment on table readiness_fields is
  'User-defined additions to the daily panel. Values live in '
  'daily_readiness.custom keyed by `key`. Archived rather than deleted, so a '
  'field somebody stops tracking does not orphan the history it already has. '
  'NOTHING MAY GATE ON THESE: a custom item is context and a chart, never a '
  'rule input, because an unvalidated item cannot carry a decision.';

alter table readiness_fields enable row level security;
create policy fields_select on readiness_fields
  for select to authenticated using (user_id = auth.uid());
create policy fields_insert on readiness_fields
  for insert to authenticated with check (user_id = auth.uid());
create policy fields_update on readiness_fields
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2. UNANCHORED, ANY NUMBER PER DAY -------------------------------------------
--
-- "Check in whenever." Episodic, read as context, and NEVER averaged into the
-- daily trend: if these fed the baseline it would depend on how often somebody
-- happened to tap, which is not a fact about their training.
create table checkins (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- prompted vs spontaneous is kept because they mean different things. An
  -- answer to "how's the achilles?" measures the prompt; an unprompted report
  -- measures salience, which is the signal that matters for injury.
  kind        text not null check (kind in ('pre_session','post_session','spontaneous','prompted')),
  session_id  uuid references sessions (id) on delete set null,
  activity_id uuid references activities (id) on delete set null,
  energy      smallint check (energy between 1 and 5),
  feeling     smallint check (feeling between 1 and 5),
  note        text check (note is null or length(note) <= 1000),
  recorded_at timestamptz not null default now()
);

comment on table checkins is
  'Unlimited per day, typed. The post_session row is where session-RPE is '
  'collected and its recorded_at is part of that measurement, since sRPE '
  'validity depends on being taken about 30 minutes post. Never averaged into '
  'daily_readiness: those are a fixed-time measurement and these are events.';

create index idx_checkins_user_time on checkins (user_id, recorded_at desc);

alter table checkins enable row level security;
create policy checkins_select on checkins
  for select to authenticated using (user_id = auth.uid());
create policy checkins_insert on checkins
  for insert to authenticated with check (user_id = auth.uid());
create policy checkins_update on checkins
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3. SYMPTOMS: AN EPISODE, NOT A DAILY SLIDER ---------------------------------
--
-- The only question worth asking about an achilles is whether it is better or
-- worse than three weeks ago, and unlinked rows cannot answer it. So a report
-- attaches to an EPISODE and the episode is the trending unit.
create table symptom_episodes (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body_region text not null check (length(trim(body_region)) between 1 and 60),
  side        text check (side in ('left','right','bilateral','n/a')),
  opened_on   date not null,
  closed_on   date,
  created_at  timestamptz not null default now(),
  check (closed_on is null or closed_on >= opened_on)
);

create table symptom_reports (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id uuid not null references symptom_episodes (id) on delete cascade,
  -- The scoring differs between versions, so this is a column rather than an
  -- assumption. Storing the raw ordinals and deriving severity in a view means
  -- a scoring correction is a CREATE OR REPLACE and never a backfill over data
  -- nobody can re-collect.
  instrument text not null check (instrument in ('ostrc_o1','ostrc_o2','ostrc_h2')),
  -- The recall period IS the measurement: seven days, ending here.
  recall_end date not null,
  q1 smallint not null check (q1 between 0 and 3),
  q2 smallint not null check (q2 between 0 and 4),
  q3 smallint not null check (q3 between 0 and 4),
  q4 smallint not null check (q4 between 0 and 3),
  recorded_at timestamptz not null default now(),
  -- v2 collapsed Q2 and Q3 to four options; v1 had five. Allowing 0-4 on the
  -- column and pinning the narrower range per version here is what stops a v2
  -- row carrying a value its own instrument has no wording for.
  check (instrument = 'ostrc_o1' or (q2 between 0 and 3 and q3 between 0 and 3)),
  unique (episode_id, recall_end)
);

comment on table symptom_reports is
  'One OSTRC response per episode per week. VERIFICATION NOTE: the v2 item '
  'wording and the collapse of Q2/Q3 to four options were reconstructed from '
  'the Oslo group''s own R package and corroborated by validation papers '
  'describing four options per question and a 0-100 score; the primary source '
  '(Clarsen 2020, BJSM 54:390-6) was not reachable when this was written. The '
  'case definitions, which are what triage branches on, were consistent across '
  'every source. Confirm the item text before comparing these numbers with '
  'anyone else''s study.';

create index idx_symptom_reports_episode on symptom_reports (episode_id, recall_end desc);
create index idx_symptom_episodes_open on symptom_episodes (user_id, body_region)
  where closed_on is null;

alter table symptom_episodes enable row level security;
alter table symptom_reports  enable row level security;
create policy sym_ep_select on symptom_episodes
  for select to authenticated using (user_id = auth.uid());
create policy sym_ep_insert on symptom_episodes
  for insert to authenticated with check (user_id = auth.uid());
create policy sym_ep_update on symptom_episodes
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sym_rp_select on symptom_reports
  for select to authenticated using (user_id = auth.uid());
create policy sym_rp_insert on symptom_reports
  for insert to authenticated with check (user_id = auth.uid());
create policy sym_rp_update on symptom_reports
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3b. MENSTRUAL CYCLE ---------------------------------------------------------
--
-- Optional, opt-in, and never assumed: no part of this schema infers that
-- anybody has a cycle, and an athlete who does not opt in has no row here and
-- notices nothing.
--
-- It earns a place for a reason stronger than the one usually given. The effect
-- of cycle PHASE on performance is genuinely contested -- the better
-- meta-analyses find small, highly variable, individual effects -- so phase is
-- context and may never gate a rule, exactly like a custom field. What is NOT
-- contested is that absent or irregular menstruation is a primary indicator in
-- the 2023 IOC consensus on Relative Energy Deficiency in Sport, alongside
-- prior stress fracture and low bone density. The red-flag path already refers
-- on those, and without somewhere to record this it was referring on a
-- criterion nobody could ever meet.
--
-- Phase is DERIVED from events rather than stored, which is this repository's
-- standing rule and also the only shape that survives an irregular cycle: a
-- stored "current phase" is wrong the moment a period is late, which is
-- precisely the case worth noticing.
create table cycle_context (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  -- What "absent" would even mean for this person. Screening for the REDs
  -- indicator is meaningless without it: somebody on continuous hormonal
  -- contraception has no withdrawal bleed by design and must never be flagged
  -- for its absence.
  status      text not null check (status in
                ('not_tracking','natural','hormonal_contraception',
                 'irregular_known','perimenopause','postmenopause','pregnant')),
  -- Their own normal, because a 24-day cycle and a 35-day cycle are both
  -- normal and only a deviation from THIS person's baseline is a signal.
  typical_length_days smallint check (typical_length_days between 15 and 90),
  notes       text check (notes is null or length(notes) <= 500),
  updated_at  timestamptz not null default now()
);

comment on table cycle_context is
  'Opt-in. Absent means not tracking, and nothing anywhere infers a cycle from '
  'anything else. status exists so REDs screening can tell "no period because '
  'continuous contraception" from "no period, and that is new", which are '
  'clinically opposite and would otherwise look identical.';

create table cycle_events (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('period_start','period_end','spotting','symptom')),
  local_date date not null,
  -- Free of any scale on purpose: cramps, migraine, low mood and heavy flow do
  -- not share a unit, and inventing one to make them chartable would be the
  -- same error as a composite readiness score.
  note       text check (note is null or length(note) <= 300),
  recorded_at timestamptz not null default now(),
  unique (user_id, kind, local_date)
);

create index idx_cycle_events_user on cycle_events (user_id, local_date desc);

alter table cycle_context enable row level security;
alter table cycle_events  enable row level security;
create policy cycle_ctx_select on cycle_context
  for select to authenticated using (user_id = auth.uid());
create policy cycle_ctx_insert on cycle_context
  for insert to authenticated with check (user_id = auth.uid());
create policy cycle_ctx_update on cycle_context
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Deletable, unlike training data. This is health information somebody may
-- simply want gone, and the same reasoning that makes coach_memory deletable
-- applies with more force here.
create policy cycle_ctx_delete on cycle_context
  for delete to authenticated using (user_id = auth.uid());
create policy cycle_ev_select on cycle_events
  for select to authenticated using (user_id = auth.uid());
create policy cycle_ev_insert on cycle_events
  for insert to authenticated with check (user_id = auth.uid());
create policy cycle_ev_update on cycle_events
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cycle_ev_delete on cycle_events
  for delete to authenticated using (user_id = auth.uid());

-- 4. PAIN AROUND ONE SESSION --------------------------------------------------
--
-- The next-morning criterion does the real work in both published
-- pain-monitoring models, and it is a 24-HOUR DELAYED signal. It cannot be a
-- column on the run: it is a separate prompt the following morning with its own
-- timestamp, which is exactly what a phase enum buys.
create table pain_checks (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id  uuid references symptom_episodes (id) on delete set null,
  session_id  uuid references sessions (id) on delete set null,
  activity_id uuid references activities (id) on delete set null,
  phase       text not null check (phase in ('during','post','next_morning')),
  nrs_0_10    smallint not null check (nrs_0_10 between 0 and 10),
  captured_at timestamptz not null default now()
);

alter table pain_checks enable row level security;
create policy pain_select on pain_checks
  for select to authenticated using (user_id = auth.uid());
create policy pain_insert on pain_checks
  for insert to authenticated with check (user_id = auth.uid());

-- 5. RED FLAGS: BOOLEANS, NOT A SCORE -----------------------------------------
--
-- Bone stress injury presentation, where ANY SINGLE ONE warrants referral
-- rather than a combination. Stored as separate booleans because a score
-- invites a threshold and the clinical literature does not provide one.
create table red_flags (
  id                       uuid primary key,
  user_id                  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  episode_id               uuid references symptom_episodes (id) on delete set null,
  focal_bone_tenderness    boolean not null default false,
  night_or_rest_pain       boolean not null default false,
  pain_on_single_leg_hop   boolean not null default false,
  pain_earlier_in_run      boolean not null default false,
  pain_in_daily_activity   boolean not null default false,
  reported_at              timestamptz not null default now(),
  referred_at              timestamptz,
  referral_acknowledged_at timestamptz,
  -- A row with nothing set is not a report of anything, and would otherwise
  -- read as a cleared flag to anyone counting rows.
  check (focal_bone_tenderness or night_or_rest_pain or pain_on_single_leg_hop
      or pain_earlier_in_run or pain_in_daily_activity)
);

alter table red_flags enable row level security;
create policy flags_select on red_flags
  for select to authenticated using (user_id = auth.uid());
create policy flags_insert on red_flags
  for insert to authenticated with check (user_id = auth.uid());
create policy flags_update on red_flags
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 6. THE DENOMINATOR ----------------------------------------------------------
--
-- Without this there is no way to tell 91% adherence from a drop-off, and
-- adherence to self-reporting is the load-bearing assumption of the entire
-- injury half. The published 82-96% figures come from supervised cohorts with a
-- researcher attached; one unsupervised athlete with a push notification is a
-- different situation, and this table is how that is discovered in four weeks
-- rather than at month six.
create table report_prompts (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('daily_readiness','ostrc_weekly','next_morning_pain','followup')),
  scheduled_for timestamptz not null,
  channel       text not null check (channel in ('push','in_app')),
  responded_at  timestamptz,
  skipped       boolean not null default false
);

create index idx_prompts_user_time on report_prompts (user_id, scheduled_for desc);

alter table report_prompts enable row level security;
create policy prompts_select on report_prompts
  for select to authenticated using (user_id = auth.uid());
create policy prompts_insert on report_prompts
  for insert to authenticated with check (user_id = auth.uid());
create policy prompts_update on report_prompts
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- VIEWS -----------------------------------------------------------------------

-- Raw ordinals to 0-100, by instrument version.
--
-- v1 gave Q2 and Q3 five options (0-6-13-19-25) and Q1/Q4 four (0-8-17-25).
-- v2 collapsed all four to four options, so every item is 0-8-17-25 and the
-- four still sum to 100. Nothing derived is stored, which is what makes a
-- correction here a view change rather than an unrecoverable backfill.
create or replace view v_ostrc_severity with (security_invoker = true) as
select
  r.id, r.user_id, r.episode_id, r.instrument, r.recall_end, r.recorded_at,
  r.q1, r.q2, r.q3, r.q4,
  (
    (array[0,8,17,25])[r.q1 + 1]
  + case when r.instrument = 'ostrc_o1'
         then (array[0,6,13,19,25])[r.q2 + 1]
         else (array[0,8,17,25])[r.q2 + 1] end
  + case when r.instrument = 'ostrc_o1'
         then (array[0,6,13,19,25])[r.q3 + 1]
         else (array[0,8,17,25])[r.q3 + 1] end
  + (array[0,8,17,25])[r.q4 + 1]
  )::int as severity,
  -- The case definitions, which are what triage actually branches on and the
  -- part every source agreed about.
  (r.q1 <> 0) as is_health_problem,
  (r.q1 = 3 or r.q2 >= 2 or r.q3 >= 2) as is_substantial
from symptom_reports r;

comment on view v_ostrc_severity is
  'OSTRC severity 0-100 derived from the raw ordinals, scored per instrument '
  'version. is_substantial is the published case definition: cannot '
  'participate, OR training modified to a moderate extent or more, OR '
  'performance affected to a moderate extent or more.';

-- What an episode is DOING, which is the only question worth asking of it.
--
-- consecutive_weeks is the one that catches things. In runners the OSTRC
-- severity score has a smallest detectable change of about 35 for an
-- INDIVIDUAL against a minimal important change of 18.5, so one person's
-- week-to-week delta is mostly noise and persistence is the overuse signature,
-- not intensity.
create or replace view v_symptom_episode_state with (security_invoker = true) as
with reports as (
  select
    s.*,
    row_number() over (partition by s.episode_id order by s.recall_end desc) as rn,
    -- Weeks are consecutive when their recall_end values are 7 days apart. The
    -- gap to the PREVIOUS report is what a run is counted from.
    s.recall_end
      - lag(s.recall_end) over (partition by s.episode_id order by s.recall_end)
      as gap_days
  from v_ostrc_severity s
),
runs as (
  select *,
    -- A new run starts whenever the gap is not exactly a week.
    sum(case when gap_days = 7 then 0 else 1 end)
      over (partition by episode_id order by recall_end
            rows between unbounded preceding and current row) as run_id
  from reports
)
select
  e.id as episode_id, e.user_id, e.body_region, e.side, e.opened_on, e.closed_on,
  (e.closed_on is null) as is_open,
  latest.severity        as latest_severity,
  latest.recall_end      as latest_recall_end,
  latest.is_substantial  as latest_is_substantial,
  coalesce(streak.weeks, 0)::int as consecutive_weeks,
  -- Three consecutive weeks in one region warrants a clinician regardless of
  -- severity. Surfaced here rather than recomputed by every caller.
  (coalesce(streak.weeks, 0) >= 3) as persistent
from symptom_episodes e
left join lateral (
  select r.severity, r.recall_end, r.is_substantial
    from runs r where r.episode_id = e.id and r.rn = 1
) latest on true
left join lateral (
  select count(*) as weeks
    from runs r
   where r.episode_id = e.id
     and r.run_id = (select r2.run_id from runs r2
                      where r2.episode_id = e.id and r2.rn = 1)
) streak on true;

comment on view v_symptom_episode_state is
  'Per episode: the latest report, whether it is substantial, and how many '
  'CONSECUTIVE weeks it has been reported. Persistence is the overuse '
  'signature; a single week-to-week change below the individual smallest '
  'detectable change (~35) is measurement noise and must not escalate.';

-- The daily panel as a trend against the person's own baseline.
--
-- EVERY ITEM IS OPTIONAL AND A HALF-FILLED ROW IS A REAL ROW. That is a product
-- decision (a panel somebody must complete is a panel somebody stops opening)
-- and it forces something on this view: `avg()` skips nulls, so a seven-day
-- mean over two answers and one over seven look identical, and a consumer that
-- cannot tell them apart will read a trend off almost nothing.
--
-- So every mean carries its own COUNT. A caller that wants to say something
-- about fatigue checks fatigue_7d_n, not days_of_history, because those are
-- different numbers the moment anyone skips a field.
create or replace view v_readiness_trend with (security_invoker = true) as
select
  user_id,
  local_date,
  sleep_hours, sleep_quality, fatigue, soreness, stress, mood,
  bodyweight_kg, resting_hr, illness, alcohol_units, travel,
  avg(sleep_hours)     over w as sleep_hours_7d,
  count(sleep_hours)   over w as sleep_hours_7d_n,
  avg(sleep_quality)   over w as sleep_quality_7d,
  count(sleep_quality) over w as sleep_quality_7d_n,
  avg(fatigue)         over w as fatigue_7d,
  count(fatigue)       over w as fatigue_7d_n,
  avg(soreness)        over w as soreness_7d,
  count(soreness)      over w as soreness_7d_n,
  avg(stress)          over w as stress_7d,
  count(stress)        over w as stress_7d_n,
  avg(mood)            over w as mood_7d,
  count(mood)          over w as mood_7d_n,
  avg(bodyweight_kg)   over w as bodyweight_kg_7d,
  count(bodyweight_kg) over w as bodyweight_kg_7d_n,
  avg(resting_hr)      over w as resting_hr_7d,
  count(resting_hr)    over w as resting_hr_7d_n,
  -- How many of the six core items this particular row answered. Zero is a
  -- legal and meaningful value: somebody opened the sheet and had nothing to
  -- say, which is different from not opening it at all, and only one of those
  -- is a gap in the series.
  ( (sleep_hours   is not null)::int
  + (sleep_quality is not null)::int
  + (fatigue       is not null)::int
  + (soreness      is not null)::int
  + (stress        is not null)::int
  + (mood          is not null)::int )::int as answered_items,
  count(*) over (partition by user_id)::int as days_of_history,
  custom,
  -- Filled in well after local morning. Not thrown away -- an evening answer is
  -- still an answer -- but flagged, because the value of an anchored series is
  -- that its rows were taken at comparable times.
  (recorded_at > ((local_date + interval '12 hours') at time zone app_tz(user_id)))
    as off_anchor
from daily_readiness
window w as (partition by user_id order by local_date
             rows between 6 preceding and current row);

comment on view v_readiness_trend is
  'Seven-day rolling means per item, never summed together, each beside the '
  'COUNT of real answers behind it -- a half-filled panel is normal and a mean '
  'over two days must not look like one over seven. answered_items 0 is a legal '
  'row: someone opened the sheet and skipped it, which is not the same as a '
  'missing day. Nothing inferred from under six weeks of one athlete is a '
  'finding, which is what days_of_history is for.';

-- REDs screening, and only screening.
--
-- The 2023 IOC consensus is explicit that CAT2 is physician-led at the
-- diagnostic step. This view therefore answers exactly one question -- has it
-- been an unusually long time since a period, for somebody whose own status
-- means that would be unexpected -- and refers. It does not stratify, it does
-- not score, and it says nothing at all about anyone who has not opted in.
create or replace view v_cycle_screen with (security_invoker = true) as
select
  c.user_id,
  c.status,
  c.typical_length_days,
  last_period.local_date as last_period_start,
  (current_date - last_period.local_date)::int as days_since_period,
  -- 90 days is the conventional threshold for secondary amenorrhoea, and the
  -- per-person cycle length is used when it is known and longer, so somebody
  -- with a naturally long cycle is not flagged for having one.
  case
    when c.status not in ('natural','irregular_known') then false
    when last_period.local_date is null then false
    else (current_date - last_period.local_date)
           > greatest(90, coalesce(c.typical_length_days, 0) * 2)
  end as refer_for_amenorrhoea
from cycle_context c
left join lateral (
  select e.local_date from cycle_events e
   where e.user_id = c.user_id and e.kind = 'period_start'
   order by e.local_date desc limit 1
) last_period on true
where c.status <> 'not_tracking';

comment on view v_cycle_screen is
  'Opt-in only, and screening only: refer_for_amenorrhoea is a prompt to see a '
  'physician, never a diagnosis, because the IOC consensus puts diagnosis '
  'beyond a consumer tool. Nobody on hormonal contraception, pregnant, or past '
  'menopause is ever flagged for an absent period, which is the distinction '
  'cycle_context exists to make. Cycle PHASE is deliberately not computed '
  'anywhere: its performance effects are small and highly individual, so it is '
  'context for a human and may not gate a rule.';
