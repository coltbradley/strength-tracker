-- What the coach concluded, and a place to check back on it.
--
-- `coach_memory` holds standing FACTS ("left shoulder does not like overhead
-- pressing"). This holds CONCLUSIONS reached from the numbers ("bodyweight is
-- down 1.8 kg over 28 days against a fueling-focused block; check back in two
-- weeks"), which is a different shape: it has a recommendation, a check-back
-- date, and a resolution the coach itself is meant to reach later. Nothing in
-- `coach_memory` models any of that, and today a conclusion like that has
-- nowhere to live between conversations — it gets recomputed, differently,
-- every time.

create table coach_observations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  topic          text not null check (topic in
                   ('bodyweight', 'fueling', 'recovery', 'lift', 'injury', 'other')),
  observation    text not null check (length(trim(observation)) between 1 and 500),
  recommendation text check (length(recommendation) <= 500),
  -- The numbers the coach saw when it reached this conclusion, frozen for a
  -- later then-vs-now comparison. This is the one carve-out from "derived
  -- metrics are never stored" (CLAUDE.md): evidence is not a metric anyone
  -- reads as current truth, it is a QUOTE of what get_trends said at the
  -- time, kept only so resolve_observation can compare then to now. No view,
  -- chart or tool may read it as a live number — get_trends is the only
  -- source of a current one. See docs/decisions.md for the carve-out itself.
  evidence       jsonb not null default '{}',
  check_back_on  date,
  status         text not null default 'open'
                   check (status in ('open', 'resolved', 'superseded')),
  outcome        text check (length(outcome) <= 500),
  superseded_by  uuid references coach_observations (id),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

comment on table coach_observations is
  'The coach''s own conclusions from the numbers, each with an optional '
  'check-back date. Not coach_memory (standing facts about the person) and '
  'not goals (measured against real sets against a target). Written only by '
  'the MCP service role: record_observation, resolve_observation. Owner may '
  'read and delete (it is the coach''s opinion, not the training record) but '
  'never edit the conclusion itself.';

comment on column coach_observations.evidence is
  'The numbers behind this observation, frozen at write time (e.g. the '
  'relevant slice of get_trends'' output). Read-only history for a '
  'then-vs-now comparison in resolve_observation; NEVER a metric source for '
  'any view, chart or tool — get_trends is live, this is a quote of it.';

comment on column coach_observations.status is
  'open = still watching, due for review at check_back_on. resolved = the '
  'coach reached a conclusion (outcome says what). superseded = replaced by '
  'a newer observation (superseded_by), e.g. the check-back date arrived and '
  'the picture changed enough to restate rather than close.';

create index idx_coach_observations_user_status
  on coach_observations (user_id, status, check_back_on);

alter table coach_observations enable row level security;

-- Owner select and delete only, like coach_memory (a fact that stops being
-- useful should be removable) but NOT owner insert/update: this is the
-- coach's own conclusion, not something the lifter authors or edits by hand.
-- Every write comes from the MCP service role (record_observation,
-- resolve_observation), which bypasses RLS entirely — these policies govern
-- only the PWA's read (History's "What the coach is watching") and its
-- delete affordance.
create policy coach_observations_select on coach_observations for select to authenticated
  using (user_id = auth.uid());
create policy coach_observations_delete on coach_observations for delete to authenticated
  using (user_id = auth.uid());

-- Trends without recomputation ------------------------------------------------
--
-- One row per user, computed at read time from views that already read
-- v_live_sets (v_weekly_volume, v_session_best_e1rm, itself built on v_e1rm):
-- bodyweight and energy read v_bodyweight and checkins directly, since
-- neither is set-derived. Nothing here is stored; get_trends and the coach's
-- per-turn TRENDS line both read this view fresh.
--
-- A user with no bodyweight log, no check-ins and no logged working sets gets
-- NO ROW at all, rather than a row of nulls and zero counts — the same
-- "absence is not evidence" discipline v_goal_progress and the subjective
-- capture views already apply. get_trends treats a missing row as "no data
-- yet", not as a trend of zero.
create view v_trend_digest with (security_invoker = true) as
with users as (
  select user_id from v_bodyweight
  union
  select user_id from checkins
  union
  select user_id from v_weekly_volume
),
bw_latest as (
  select distinct on (user_id) user_id, weight_kg as bw_latest_kg, measured_at as bw_latest_at
  from v_bodyweight
  order by user_id, measured_at desc
),
bw_7d as (
  select user_id,
    round(avg(weight_kg), 2) as bw_7d_mean_kg,
    count(*)::int as bw_7d_n
  from v_bodyweight
  where measured_at >= now() - interval '7 days'
  group by user_id
),
bw_28d as (
  select user_id,
    round(avg(weight_kg), 2) as bw_28d_mean_kg,
    count(*)::int as bw_28d_n,
    -- kg per week: the regression's x axis is seconds, divided down to weeks.
    round(regr_slope(weight_kg, extract(epoch from measured_at) / 604800.0)::numeric, 3)
      as bw_28d_slope_kg_per_week
  from v_bodyweight
  where measured_at >= now() - interval '28 days'
  group by user_id
),
energy_14d as (
  select user_id,
    round(avg(energy), 2) as energy_14d_mean,
    count(energy)::int as energy_14d_n
  from checkins
  where recorded_at >= now() - interval '14 days'
  group by user_id
),
top5 as (
  select user_id, exercise_id, sum(working_sets)::int as working_sets_8w,
    row_number() over (
      partition by user_id order by sum(working_sets) desc, exercise_id
    ) as rn
  from v_weekly_volume
  where week_start >= current_date - 56
  group by user_id, exercise_id
),
lift_stats as (
  select
    t.user_id, t.exercise_id, e.name, t.working_sets_8w,
    (select v.best_e1rm_kg from v_session_best_e1rm v
       where v.user_id = t.user_id and v.exercise_id = t.exercise_id
       order by v.performed_at desc limit 1) as e1rm_latest_kg,
    (select v.best_e1rm_kg from v_session_best_e1rm v
       where v.user_id = t.user_id and v.exercise_id = t.exercise_id
         and v.performed_at <= now() - interval '4 weeks'
       order by v.performed_at desc limit 1) as e1rm_4w_ago_kg,
    coalesce((select w.working_sets from v_weekly_volume w
       where w.user_id = t.user_id and w.exercise_id = t.exercise_id
         and w.week_start = (date_trunc('week', now() at time zone app_tz(t.user_id)))::date
      ), 0) as working_sets_this_week,
    coalesce((select w.working_sets from v_weekly_volume w
       where w.user_id = t.user_id and w.exercise_id = t.exercise_id
         and w.week_start = (date_trunc('week', now() at time zone app_tz(t.user_id)))::date - 7
      ), 0) as working_sets_last_week
  from top5 t
  join exercises e on e.id = t.exercise_id
  where t.rn <= 5
),
lifts_agg as (
  select user_id,
    json_agg(json_build_object(
      'exercise_id', exercise_id,
      'name', name,
      'e1rm_latest_kg', e1rm_latest_kg,
      'e1rm_4w_ago_kg', e1rm_4w_ago_kg,
      'working_sets_this_week', working_sets_this_week,
      'working_sets_last_week', working_sets_last_week
    ) order by working_sets_8w desc) as lifts
  from lift_stats
  group by user_id
)
select
  u.user_id,
  bl.bw_latest_kg, bl.bw_latest_at,
  b7.bw_7d_mean_kg, coalesce(b7.bw_7d_n, 0) as bw_7d_n,
  b28.bw_28d_mean_kg, coalesce(b28.bw_28d_n, 0) as bw_28d_n,
  b28.bw_28d_slope_kg_per_week,
  e14.energy_14d_mean, coalesce(e14.energy_14d_n, 0) as energy_14d_n,
  coalesce(la.lifts, '[]'::json) as lifts
from users u
left join bw_latest bl on bl.user_id = u.user_id
left join bw_7d b7 on b7.user_id = u.user_id
left join bw_28d b28 on b28.user_id = u.user_id
left join energy_14d e14 on e14.user_id = u.user_id
left join lifts_agg la on la.user_id = u.user_id;

comment on view v_trend_digest is
  'One row per user with data, computed fresh at read time. Every mean '
  'carries its own count (bw_7d_mean_kg/bw_7d_n, bw_28d_mean_kg/bw_28d_n, '
  'energy_14d_mean/energy_14d_n) because avg() skips nulls. lifts is the top '
  '5 exercises by working sets in the last 8 weeks, each with e1RM now vs 4 '
  'weeks ago and working sets this week vs last. Read by get_trends and the '
  'coach''s per-turn TRENDS line; nothing here is ever written back.';
