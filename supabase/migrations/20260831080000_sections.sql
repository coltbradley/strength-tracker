-- Named sections inside a workout, and exercises that are done rather than counted.
--
-- A session is not a flat list. It is "activations, then the main lift, then
-- abs" — and the parts behave differently: nobody records 12 reps at 0 kg for a
-- banded glute bridge, they record that they did it. Forcing every movement
-- through weight-and-reps made the warmup half of a session either a lie or
-- unlogged.
--
-- A section is a NAME on a prescription, not a table. Consecutive rows sharing
-- one render under a heading, which is the same shape supersets already use
-- (superset_group) and the same shape ramps already use (a repeated
-- exercise_id). A third grouping concept with its own table would be a third
-- way to express "these rows belong together".
alter table prescriptions add column section text
  check (section is null or length(trim(section)) between 1 and 40);

comment on column prescriptions.section is
  'Optional heading this prescription sits under ("Activations", "Abs"). '
  'Consecutive rows sharing a section render as one titled block. Null is the '
  'main body of the workout, which needs no heading.';

-- How a movement is logged.
--
-- 'reps' is everything that has always existed: load and reps.
-- 'done' is a tick — a mobility drill, a band activation, a carry someone
-- times on their own watch. It still writes a real row in `sets` (reps 0 at
-- load 0, both already legal), because the alternative is a second kind of
-- record that no view, no chart and no MCP tool knows how to read.
create type tracking_mode as enum ('reps', 'done');

alter table prescriptions
  add column tracking tracking_mode not null default 'reps';

comment on column prescriptions.tracking is
  'reps = load and reps, the default and what every view analyses. done = a '
  'completion tick, written as a real set with reps 0 at load 0 so it stays '
  'one record; it is excluded from volume and e1RM by those views'' existing '
  'working-set and rep-range filters.';

-- Expose both. Restated in full because `create or replace view` cannot add a
-- column in the middle of the list.
create or replace view v_resolved_prescriptions with (security_invoker = true) as
select
  p.id, p.user_id, p.planned_workout_id, p.exercise_id, e.name as exercise_name,
  p.position, p.sets, p.reps_min, p.reps_max, p.rest_seconds, p.notes,
  p.load_kg, p.load_pct_tm, tm.value_kg as tm_kg,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as resolved_load_kg,
  round(coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) / 2.5) * 2.5 as plate_load_kg,
  p.superset_group,
  p.load_entry,
  p.set_type,
  p.section,
  p.tracking
from prescriptions p
join exercises e on e.id = p.exercise_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id;

-- v_weekly_volume and v_e1rm need no change and deliberately get none: a
-- 'done' set is reps 0, so it contributes 0 tonnage and is outside e1RM's
-- 1-8 rep window already. Adding a tracking filter there would couple the
-- analytics to the plan, which is the mistake v_adherence avoids too.
