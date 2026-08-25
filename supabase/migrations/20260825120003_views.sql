-- Derived metrics. Views only, never materialized, never stored.
-- security_invoker=true so RLS on the underlying tables applies to callers.

-- Current training max per user/exercise (latest effective_date <= today).
create view v_current_tm with (security_invoker = true) as
select distinct on (user_id, exercise_id)
  user_id, exercise_id, value_kg, effective_date
from training_maxes
where effective_date <= current_date
order by user_id, exercise_id, effective_date desc;

-- Prescriptions with %TM resolved against the current training max.
-- resolved_load_kg is null when load_pct_tm is set but no TM row exists:
-- surfacing that gap is the point (the spec forbids silently guessing).
-- plate_load_kg rounds to the nearest 2.5 kg for gym use.
create view v_resolved_prescriptions with (security_invoker = true) as
select
  p.id, p.user_id, p.planned_workout_id, p.exercise_id, e.name as exercise_name,
  p.position, p.sets, p.reps_min, p.reps_max, p.rest_seconds, p.notes,
  p.load_kg, p.load_pct_tm, tm.value_kg as tm_kg,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as resolved_load_kg,
  round(coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) / 2.5) * 2.5 as plate_load_kg
from prescriptions p
join exercises e on e.id = p.exercise_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id;

-- Epley e1RM, working sets only, 1-8 reps (estimate degrades above 8).
create view v_e1rm with (security_invoker = true) as
select
  s.user_id, s.exercise_id, s.session_id, s.id as set_id,
  s.performed_at, s.load_kg, s.reps,
  round(s.load_kg * (1 + s.reps / 30.0), 1) as e1rm_kg
from sets s
where s.set_type = 'working'
  and s.reps between 1 and 8
  and s.load_kg > 0;

-- Best e1RM per session per exercise (chart-ready series).
create view v_session_best_e1rm with (security_invoker = true) as
select user_id, exercise_id, session_id,
  min(performed_at) as performed_at,
  max(e1rm_kg) as best_e1rm_kg
from v_e1rm
group by user_id, exercise_id, session_id;

-- Working sets per exercise per ISO week (date_trunc('week') = ISO Monday).
create view v_weekly_volume with (security_invoker = true) as
select
  user_id, exercise_id,
  (date_trunc('week', performed_at))::date as week_start,
  count(*) as working_sets,
  sum(load_kg * reps) as tonnage_kg
from sets
where set_type = 'working'
group by user_id, exercise_id, (date_trunc('week', performed_at))::date;

-- Prescribed vs achieved, the analytical core of the system.
-- rep_outcome: hit / missed / exceeded against the prescribed rep range.
-- prescribed_load_kg resolves %TM against the TM effective on the day the set
-- was performed, not today's TM.
create view v_adherence with (security_invoker = true) as
select
  s.id as set_id, s.user_id, s.session_id, s.exercise_id,
  s.prescription_id, s.set_index, s.performed_at,
  s.load_kg as actual_load_kg, s.reps as actual_reps,
  p.reps_min, p.reps_max,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as prescribed_load_kg,
  s.load_kg - coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as load_delta_kg,
  case
    when s.reps < p.reps_min then 'missed'
    when s.reps > p.reps_max then 'exceeded'
    else 'hit'
  end as rep_outcome
from sets s
join prescriptions p on p.id = s.prescription_id
left join lateral (
  select t.value_kg
  from training_maxes t
  where t.user_id = s.user_id
    and t.exercise_id = s.exercise_id
    and t.effective_date <= s.performed_at::date
  order by t.effective_date desc
  limit 1
) tm on true
where s.set_type in ('working', 'backoff');

-- Rest before each set (same session + exercise). Free proxy for difficulty.
create view v_rest with (security_invoker = true) as
select
  user_id, session_id, exercise_id, id as set_id, set_index, performed_at,
  extract(epoch from performed_at - lag(performed_at) over (
    partition by session_id, exercise_id order by performed_at
  ))::int as rest_seconds_before
from sets;

-- e1RM trend vs goal.
create view v_goal_progress with (security_invoker = true) as
select
  g.id as goal_id, g.user_id, g.exercise_id, e.name as exercise_name,
  g.target_e1rm_kg, g.target_date,
  recent.best_e1rm_kg  as recent_best_e1rm_kg,   -- last 45 days
  alltime.best_e1rm_kg as alltime_best_e1rm_kg,
  round(recent.best_e1rm_kg / g.target_e1rm_kg * 100, 1) as pct_of_target
from goals g
join exercises e on e.id = g.exercise_id
left join lateral (
  select max(v.e1rm_kg) as best_e1rm_kg from v_e1rm v
  where v.user_id = g.user_id and v.exercise_id = g.exercise_id
    and v.performed_at > now() - interval '45 days'
) recent on true
left join lateral (
  select max(v.e1rm_kg) as best_e1rm_kg from v_e1rm v
  where v.user_id = g.user_id and v.exercise_id = g.exercise_id
) alltime on true;
