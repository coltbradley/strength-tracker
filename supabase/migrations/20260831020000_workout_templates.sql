-- Saved workouts you can drop onto a day later.
--
-- A template is the same thing as a planned day minus the date: a name and an
-- ordered list of prescriptions. Rather than build a parallel table pair
-- (workout_templates + template_prescriptions) that duplicates the whole
-- prescription shape and cuts the plan editor and the MCP off from it, a
-- template IS a planned_workout carrying a flag.
--
-- The cost of that choice is leakage: every read that lists planned days must
-- exclude templates or they appear on the calendar. Two things contain it.
-- First, a template can never have a scheduled_date (checked below), so every
-- date-keyed read excludes them already. Second, v_plan_workouts exists so the
-- dateless reads have something to select from that cannot include one.
alter table planned_workouts
  add column is_template boolean not null default false;

-- A template is dateless by definition. Without this, one could be scheduled,
-- appear on the calendar, be trained against, and stop being a template while
-- still claiming to be one.
alter table planned_workouts
  add constraint planned_workouts_template_has_no_date
  check (not (is_template and scheduled_date is not null));

comment on column planned_workouts.is_template is
  'A saved workout with no date, applied onto a day later. Never appears on '
  'the calendar. Read planned days through v_plan_workouts, which excludes '
  'these, rather than filtering at each call site.';

-- The plannable days, which is what every calendar, Today list and program
-- read actually wants. Templates are the only thing it drops.
create view v_plan_workouts with (security_invoker = true) as
select id, user_id, program_id, day_index, label, notes,
       scheduled_date, plan_note, skipped_at
from planned_workouts
where not is_template;

-- Index the template lookup: it is a small list read every time the template
-- picker opens, and it must not scan the whole plan history to find it.
create index idx_pw_templates on planned_workouts (user_id, label)
  where is_template;
