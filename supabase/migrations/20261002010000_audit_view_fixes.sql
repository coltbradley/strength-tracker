-- Audit 2026-10-01, stream A: view correctness (DB-5, DB-6, DB-7, DB-11).
-- Each view starts from the LATEST definition in the chain (read back with
-- pg_get_viewdef), keeps security_invoker, v_live_sets and every column in
-- its existing order. DB-5 is what happens otherwise: 20260924003054
-- re-created v_adherence from an older copy and dropped the multi-user tz fix.

-- DB-5 + DB-7. A training max takes effect in its OWNER's calendar, so the
-- lookup is app_tz(s.user_id), not app_tz() (the caller's, which is the
-- deployment default on the service-role path).
-- DB-7: a done/time prescription requires reps_min >= 1 and its logged set
-- has reps 0, so the reps comparison called every completed tick "missed".
-- Reading the PRESCRIPTION's tracking column is not a filter on the set
-- views (AGENTS.md: no `tracking` filter on volume/e1RM); the outcome is
-- simply not defined for a row whose job was never to hit a rep range.
create or replace view v_adherence with (security_invoker = true) as
select
  s.id as set_id,
  s.user_id,
  s.session_id,
  s.exercise_id,
  s.prescription_id,
  s.set_index,
  s.performed_at,
  s.load_kg as actual_load_kg,
  s.reps as actual_reps,
  p.reps_min,
  p.reps_max,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as prescribed_load_kg,
  s.load_kg - coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as load_delta_kg,
  case
    when p.tracking <> 'reps' then null::text
    when s.reps < p.reps_min then 'missed'
    when s.reps > p.reps_max then 'exceeded'
    else 'hit'
  end as rep_outcome,
  s.load_entry as actual_load_entry,
  p.load_entry as prescribed_load_entry,
  s.entered_load as actual_entered_load,
  s.entered_unit as actual_entered_unit,
  p.entered_load as prescribed_entered_load,
  p.entered_unit as prescribed_entered_unit
from v_live_sets s
join prescriptions p on p.id = s.prescription_id
left join lateral (
  select t.value_kg
    from training_maxes t
   where t.user_id = s.user_id
     and t.exercise_id = s.exercise_id
     and t.effective_date <= (s.performed_at at time zone app_tz(s.user_id))::date
   order by t.effective_date desc
   limit 1
) tm on true
where s.set_type in ('working', 'backoff');

-- DB-6: "working sets" counts sets with reps. A completion tick or a timed
-- hold is a real row in `sets` with reps 0 (AGENTS.md), and counting it
-- inflated volume, the session counts, the weekly summary and, through
-- top5, the exercises the coach is told someone trains most. The filter is
-- on reps, never on `tracking`. Tonnage and e1RM were already right.
create or replace view v_weekly_volume with (security_invoker = true) as
select
  user_id,
  exercise_id,
  date_trunc('week', (performed_at at time zone app_tz(user_id)))::date as week_start,
  count(*) as working_sets,
  sum(load_kg * reps::numeric) as tonnage_kg
from v_live_sets
where set_type = 'working' and reps > 0
group by user_id, exercise_id, date_trunc('week', (performed_at at time zone app_tz(user_id)))::date;

-- total_sets stays every logged row; only the working count changes.
create or replace view v_session_set_counts with (security_invoker = true) as
select
  user_id,
  session_id,
  count(*) as total_sets,
  count(*) filter (where set_type = 'working' and reps > 0) as working_sets
from v_live_sets
group by user_id, session_id;

create or replace view v_weekly_summary with (security_invoker = true) as
with trained as (
  select
    user_id,
    date_trunc('week', (performed_at at time zone app_tz(user_id)))::date as week_start,
    count(*) filter (where set_type = 'working' and reps > 0) as working_sets,
    coalesce(sum(load_kg * reps::numeric) filter (where set_type = 'working'), 0::numeric) as tonnage_kg
  from v_live_sets
  group by user_id, date_trunc('week', (performed_at at time zone app_tz(user_id)))::date
), sessed as (
  select
    user_id,
    date_trunc('week', (started_at at time zone app_tz(user_id)))::date as week_start,
    count(*) filter (where ended_at is not null) as sessions,
    avg(session_rpe) filter (where session_rpe is not null) as avg_session_rpe
  from sessions
  where discarded_at is null
  group by user_id, date_trunc('week', (started_at at time zone app_tz(user_id)))::date
), planned as (
  select
    w.user_id,
    date_trunc('week', w.scheduled_date::timestamp with time zone)::date as week_start,
    count(*) as planned_days,
    count(*) filter (where exists (
      select 1 from sessions s
       where s.planned_workout_id = w.id and s.ended_at is not null and s.discarded_at is null
    )) as planned_days_done
  from v_plan_workouts w
  where w.scheduled_date is not null and w.exercise_count > 0
  group by w.user_id, date_trunc('week', w.scheduled_date::timestamp with time zone)::date
), weeks as (
  select user_id, week_start from trained
  union
  select user_id, week_start from sessed
  union
  select user_id, week_start from planned
)
select
  k.user_id,
  k.week_start,
  coalesce(se.sessions, 0::bigint)::integer as sessions,
  coalesce(t.working_sets, 0::bigint)::integer as working_sets,
  coalesce(t.tonnage_kg, 0::numeric) as tonnage_kg,
  round(se.avg_session_rpe, 1) as avg_session_rpe,
  coalesce(p.planned_days, 0::bigint)::integer as planned_days,
  coalesce(p.planned_days_done, 0::bigint)::integer as planned_days_done
from weeks k
left join trained t on t.user_id = k.user_id and t.week_start = k.week_start
left join sessed se on se.user_id = k.user_id and se.week_start = k.week_start
left join planned p on p.user_id = k.user_id and p.week_start = k.week_start;

-- DB-11: the 8-week window edge is the lifter's calendar day, not the
-- database's (UTC on Supabase). Everything else in the view already used
-- app_tz(user_id); `current_date` was the one holdout. v_weekly_volume is
-- re-created above with the same columns, so this view does not need to
-- change shape; it is replaced only for the window.
create or replace view v_trend_digest with (security_invoker = true) as
with users as (
  select user_id from v_bodyweight
  union
  select user_id from checkins
  union
  select user_id from v_weekly_volume
), bw_latest as (
  select distinct on (user_id)
    user_id,
    weight_kg as bw_latest_kg,
    measured_at as bw_latest_at
  from v_bodyweight
  order by user_id, measured_at desc
), bw_7d as (
  select
    user_id,
    round(avg(weight_kg), 2) as bw_7d_mean_kg,
    count(*)::integer as bw_7d_n
  from v_bodyweight
  where measured_at >= (now() - interval '7 days')
  group by user_id
), bw_28d as (
  select
    user_id,
    round(avg(weight_kg), 2) as bw_28d_mean_kg,
    count(*)::integer as bw_28d_n,
    round(regr_slope(weight_kg::double precision, (extract(epoch from measured_at) / 604800.0)::double precision)::numeric, 3) as bw_28d_slope_kg_per_week
  from v_bodyweight
  where measured_at >= (now() - interval '28 days')
  group by user_id
), energy_14d as (
  select
    user_id,
    round(avg(energy), 2) as energy_14d_mean,
    count(energy)::integer as energy_14d_n
  from checkins
  where recorded_at >= (now() - interval '14 days')
  group by user_id
), top5 as (
  select
    user_id,
    exercise_id,
    sum(working_sets)::integer as working_sets_8w,
    row_number() over (partition by user_id order by sum(working_sets) desc, exercise_id) as rn
  from v_weekly_volume
  where week_start >= ((now() at time zone app_tz(user_id))::date - 56)
  group by user_id, exercise_id
), lift_stats as (
  select
    t.user_id,
    t.exercise_id,
    e.name,
    t.working_sets_8w,
    (select v.best_e1rm_kg
       from v_session_best_e1rm v
      where v.user_id = t.user_id and v.exercise_id = t.exercise_id
      order by v.performed_at desc
      limit 1) as e1rm_latest_kg,
    (select v.best_e1rm_kg
       from v_session_best_e1rm v
      where v.user_id = t.user_id and v.exercise_id = t.exercise_id
        and v.performed_at <= (now() - interval '28 days')
      order by v.performed_at desc
      limit 1) as e1rm_4w_ago_kg,
    coalesce((select w.working_sets
                from v_weekly_volume w
               where w.user_id = t.user_id and w.exercise_id = t.exercise_id
                 and w.week_start = date_trunc('week', (now() at time zone app_tz(t.user_id)))::date), 0::bigint) as working_sets_this_week,
    coalesce((select w.working_sets
                from v_weekly_volume w
               where w.user_id = t.user_id and w.exercise_id = t.exercise_id
                 and w.week_start = (date_trunc('week', (now() at time zone app_tz(t.user_id)))::date - 7)), 0::bigint) as working_sets_last_week
  from top5 t
  join exercises e on e.id = t.exercise_id
  where t.rn <= 5
), lifts_agg as (
  select
    user_id,
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
  bl.bw_latest_kg,
  bl.bw_latest_at,
  b7.bw_7d_mean_kg,
  coalesce(b7.bw_7d_n, 0) as bw_7d_n,
  b28.bw_28d_mean_kg,
  coalesce(b28.bw_28d_n, 0) as bw_28d_n,
  b28.bw_28d_slope_kg_per_week,
  e14.energy_14d_mean,
  coalesce(e14.energy_14d_n, 0) as energy_14d_n,
  coalesce(la.lifts, '[]'::json) as lifts
from users u
left join bw_latest bl on bl.user_id = u.user_id
left join bw_7d b7 on b7.user_id = u.user_id
left join bw_28d b28 on b28.user_id = u.user_id
left join energy_14d e14 on e14.user_id = u.user_id
left join lifts_agg la on la.user_id = u.user_id;

create or replace view v_cycle_screen with (security_invoker = true) as
select
  c.user_id,
  c.status,
  c.typical_length_days,
  last_period.local_date as last_period_start,
  (now() at time zone app_tz(c.user_id))::date - last_period.local_date as days_since_period,
  case
    when c.status <> all (array['natural', 'irregular_known']) then false
    when last_period.local_date is null then false
    else ((now() at time zone app_tz(c.user_id))::date - last_period.local_date) > greatest(90, coalesce(c.typical_length_days::integer, 0) * 2)
  end as refer_for_amenorrhoea
from cycle_context c
left join lateral (
  select e.local_date
    from cycle_events e
   where e.user_id = c.user_id and e.kind = 'period_start'
   order by e.local_date desc
   limit 1
) last_period on true
where c.status <> 'not_tracking';
