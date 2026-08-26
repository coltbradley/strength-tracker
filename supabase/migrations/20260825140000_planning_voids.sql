-- Planning + correction layer (all additive; see docs/decisions.md 2026-08-25
-- "Planning round").
--
-- 1. planned_workouts grows calendar + user-owned planning fields. The PWA
--    now edits planned tables directly (the RLS policies always allowed it).
--    `notes` stays coach notes from the parse; `plan_note` is the user's own
--    pre-workout note.
-- 2. sessions get a soft delete (`discarded_at`). No delete policy is added;
--    a discarded session's rows stay in Postgres but leave every view.
-- 3. sets stay append-only. A wrong set is corrected by voiding it: an
--    insert into `set_voids`, itself append-only (no update/delete policies).
-- 4. `v_live_sets` is the one place "visible sets" is defined; every derived
--    view now reads it instead of `sets`.

-- 1. planned_workouts ---------------------------------------------------------

alter table planned_workouts add column scheduled_date date;
alter table planned_workouts add column plan_note text;
alter table planned_workouts add column skipped_at timestamptz;

create index idx_pw_schedule on planned_workouts (user_id, scheduled_date);

-- 2. sessions soft delete -----------------------------------------------------

alter table sessions add column discarded_at timestamptz;

-- 3. set voids ----------------------------------------------------------------

create table set_voids (
  set_id     uuid primary key references sets (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table set_voids enable row level security;
-- append-only: select + insert, no update or delete policy on purpose.
-- The insert check also proves the voided set is the caller's own (the FK
-- alone would not: FK checks bypass RLS).
create policy set_voids_select on set_voids for select to authenticated using (user_id = auth.uid());
create policy set_voids_insert on set_voids for insert to authenticated with check (
  user_id = auth.uid()
  and exists (select 1 from sets s where s.id = set_id and s.user_id = auth.uid())
);

-- 4. views --------------------------------------------------------------------

-- Sets that count: not voided, not on a discarded session.
create view v_live_sets with (security_invoker = true) as
select s.*
from sets s
join sessions ss on ss.id = s.session_id
where ss.discarded_at is null
  and not exists (
    select 1 from set_voids v
    where v.set_id = s.id and v.user_id = s.user_id
  );

-- Recreate the set-derived views on top of v_live_sets. Column lists are
-- unchanged, so `create or replace` is safe and dependents (e.g.
-- v_session_best_e1rm, v_goal_progress over v_e1rm) follow automatically.

create or replace view v_e1rm with (security_invoker = true) as
select
  s.user_id, s.exercise_id, s.session_id, s.id as set_id,
  s.performed_at, s.load_kg, s.reps,
  round(s.load_kg * (1 + s.reps / 30.0), 1) as e1rm_kg
from v_live_sets s
where s.set_type = 'working'
  and s.reps between 1 and 8
  and s.load_kg > 0;

create or replace view v_weekly_volume with (security_invoker = true) as
select
  user_id, exercise_id,
  (date_trunc('week', performed_at at time zone app_tz()))::date as week_start,
  count(*) as working_sets,
  sum(load_kg * reps) as tonnage_kg
from v_live_sets
where set_type = 'working'
group by user_id, exercise_id, (date_trunc('week', performed_at at time zone app_tz()))::date;

create or replace view v_session_set_counts with (security_invoker = true) as
select
  user_id, session_id,
  count(*) as total_sets,
  count(*) filter (where set_type = 'working') as working_sets
from v_live_sets
group by user_id, session_id;

create or replace view v_adherence with (security_invoker = true) as
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
from v_live_sets s
join prescriptions p on p.id = s.prescription_id
left join lateral (
  select t.value_kg
  from training_maxes t
  where t.user_id = s.user_id
    and t.exercise_id = s.exercise_id
    and t.effective_date <= (s.performed_at at time zone app_tz())::date
  order by t.effective_date desc
  limit 1
) tm on true
where s.set_type in ('working', 'backoff');

create or replace view v_rest with (security_invoker = true) as
select
  user_id, session_id, exercise_id, id as set_id, set_index, performed_at,
  extract(epoch from performed_at - lag(performed_at) over (
    partition by session_id, exercise_id order by performed_at
  ))::int as rest_seconds_before
from v_live_sets;
