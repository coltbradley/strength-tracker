-- The week, in one row.
--
-- "How many working sets did I do this week" and "did I train what I planned"
-- both currently require the coach to fetch a history and add it up, which is
-- slow, costs tokens, and gives a slightly different answer each time it is
-- asked. Derived metrics belong in SQL, so this is a view.
--
-- Weeks are bucketed the way every other calendar view buckets: date_trunc on
-- the user's own timezone via app_tz(user_id), passing the user_id OF THE ROW
-- rather than auth.uid(), so the service-role (MCP) path and the PWA path
-- agree about which Monday a Sunday-night session belongs to.

create view v_weekly_summary with (security_invoker = true) as
with
-- Every week this person has anything at all, from either side. A week with
-- training but no plan, and a week with a plan and no training, are both real
-- and both worth a row; an inner join between the two would hide exactly the
-- weeks someone wants explaining.
trained as (
  select
    user_id,
    (date_trunc('week', performed_at at time zone app_tz(user_id)))::date as week_start,
    count(*) filter (where set_type = 'working') as working_sets,
    coalesce(sum(load_kg * reps) filter (where set_type = 'working'), 0) as tonnage_kg
  from v_live_sets
  group by user_id, (date_trunc('week', performed_at at time zone app_tz(user_id)))::date
),
sessed as (
  select
    user_id,
    (date_trunc('week', started_at at time zone app_tz(user_id)))::date as week_start,
    -- Only finished sessions count. An open one is someone mid-workout or an
    -- abandoned start, and neither is a training session yet: the same rule
    -- Today uses to decide a planned day is done.
    count(*) filter (where ended_at is not null) as sessions,
    avg(session_rpe) filter (where session_rpe is not null) as avg_session_rpe
  from sessions
  where discarded_at is null
  group by user_id, (date_trunc('week', started_at at time zone app_tz(user_id)))::date
),
planned as (
  select
    w.user_id,
    (date_trunc('week', w.scheduled_date))::date as week_start,
    count(*) as planned_days,
    count(*) filter (
      where exists (
        select 1 from sessions s
        where s.planned_workout_id = w.id
          and s.ended_at is not null
          and s.discarded_at is null
      )
    ) as planned_days_done
  from v_plan_workouts w
  -- A day with nothing programmed into it is a DRAFT, not a workout someone
  -- owes: counting it would make abandoning the plan editor look like missing
  -- a session, which is the same mistake Today's week strip already avoids.
  where w.scheduled_date is not null
    and w.exercise_count > 0
  group by w.user_id, (date_trunc('week', w.scheduled_date))::date
),
weeks as (
  select user_id, week_start from trained
  union
  select user_id, week_start from sessed
  union
  select user_id, week_start from planned
)
select
  k.user_id,
  k.week_start,
  coalesce(se.sessions, 0)::int as sessions,
  coalesce(t.working_sets, 0)::int as working_sets,
  coalesce(t.tonnage_kg, 0) as tonnage_kg,
  round(se.avg_session_rpe, 1) as avg_session_rpe,
  coalesce(p.planned_days, 0)::int as planned_days,
  coalesce(p.planned_days_done, 0)::int as planned_days_done
from weeks k
left join trained  t  on t.user_id  = k.user_id and t.week_start  = k.week_start
left join sessed   se on se.user_id = k.user_id and se.week_start = k.week_start
left join planned  p  on p.user_id  = k.user_id and p.week_start  = k.week_start;

comment on view v_weekly_summary is
  'One row per person per ISO week they have training or a plan in, bucketed '
  'in that person''s own timezone. Deliberately reports planned_days and '
  'planned_days_done as counts rather than a percentage: a week with no plan '
  'has no adherence, and a ratio would render that as zero, which reads as '
  'total failure instead of "nothing was asked".';
