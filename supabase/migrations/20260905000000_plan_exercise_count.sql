-- A planned day with no exercises in it is a DRAFT, not a workout that was
-- missed.
--
-- "Plan a workout" creates a dated day and opens its editor. Abandon it there
-- and the day still exists, empty, and the moment its date passes Today calls
-- it MISSED — forever, for a workout that was never programmed. A real user
-- has one of these sitting on her calendar from 2026-08-30, next to three
-- sessions she actually trained.
--
-- Today cannot tell the difference on its own: it loads prescriptions lazily,
-- for the selected day and today's, so for every other cell in the week strip
-- it has no idea whether the day holds anything. The count belongs with the
-- row it describes.
--
-- Additive: existing selects that do not name the column are unaffected.
create or replace view v_plan_workouts with (security_invoker = true) as
select w.id, w.user_id, w.program_id, w.day_index, w.label, w.notes,
       w.scheduled_date, w.plan_note, w.skipped_at,
       -- Counts what the day ASKS for, not what was done, and counts
       -- prescription ROWS rather than summing their `sets`: a ramp is three
       -- rows and one exercise, and either number answers "is this day empty".
       (select count(*)
          from prescriptions r
         where r.planned_workout_id = w.id)::int as exercise_count
from planned_workouts w
join programs p on p.id = w.program_id
where not w.is_template
  and p.discarded_at is null
  and w.discarded_at is null;

comment on view v_plan_workouts is
  'Planned days on the calendar: templates and days belonging to discarded '
  'programs are excluded. exercise_count is 0 for a day nothing has been '
  'programmed into yet, which the app shows as a draft rather than as missed.';
