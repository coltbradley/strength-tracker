-- Deleting a planned day destroyed the adherence history of sets already
-- logged against it.
--
-- The chain: prescriptions reference planned_workouts ON DELETE CASCADE
-- (schema.sql:78), and sets.prescription_id references prescriptions ON DELETE
-- SET NULL (schema.sql:114). So a hard delete of one planned day cascaded to
-- its prescriptions and silently nulled the link from every set that had ever
-- fulfilled them. `sets` is append-only: nothing can put that link back.
--
-- The sets themselves survived, which is what "logged sessions and sets always
-- survive" was taken to mean. But what the plan ASKED for is the whole content
-- of v_adherence, and History renders it as the one line above each session:
-- "3x3-5 @ 144 KG". After a plan edit, that line was gone for good — and the
-- PWA reached this on the ordinary edit path, not through anything exotic.
--
-- 20260831060000 established the rule for programs ("nothing a model can reach
-- should be unrecoverable") and gave them discarded_at. It stopped one level
-- too high: a planned day could still be hard-deleted underneath a program
-- that was itself carefully soft-deleted. This finishes that work, using the
-- same column name and the same shape, so the schema has ONE soft-delete
-- idiom rather than two.
--
-- Prescriptions deliberately do NOT get their own discarded_at. A prescription
-- has no independent life: it exists as part of a day, it is reached only
-- through one, and giving it a second nullable timestamp would mean every read
-- filtering on two. Removing a single exercise from a day is a genuine hard
-- delete and stays one — but see the guard at the bottom, which stops that
-- from severing history either.

alter table planned_workouts add column discarded_at timestamptz;

comment on column planned_workouts.discarded_at is
  'Soft delete, matching programs.discarded_at and sessions.discarded_at. A '
  'discarded day leaves every view but stays in Postgres, so the sets logged '
  'against its prescriptions keep the link that v_adherence reads. There is '
  'no hard-delete path a client should reach.';

create index idx_pw_live on planned_workouts (user_id, scheduled_date)
  where discarded_at is null;

-- v_plan_workouts is the single place every plan read goes, so the filter
-- belongs here rather than in each caller (the same argument
-- 20260831060000 made for the programs join).
create or replace view v_plan_workouts with (security_invoker = true) as
select w.id, w.user_id, w.program_id, w.day_index, w.label, w.notes,
       w.scheduled_date, w.plan_note, w.skipped_at
from planned_workouts w
join programs p on p.id = w.program_id
where not w.is_template
  and p.discarded_at is null
  and w.discarded_at is null;

-- v_resolved_prescriptions read prescriptions directly, so it would show the
-- contents of discarded days — and already showed those of discarded
-- PROGRAMS, which is why getUnresolvedTmExercises warns about a missing
-- training max for a plan the user deleted last month.
--
-- It joins planned_workouts directly rather than through v_plan_workouts,
-- because that view also hides TEMPLATES, and a template owns prescriptions
-- like any other day — applying one reads them straight back out. (The
-- validate-db check "a template still owns prescriptions like any other day"
-- catches exactly this, and caught it here.) Discarded is the filter that
-- belongs; being a template is not.
--
-- Restated in full because `create or replace view` cannot add a column
-- mid-list.
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
join planned_workouts w on w.id = p.planned_workout_id
join programs pr on pr.id = w.program_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id
where w.discarded_at is null
  and pr.discarded_at is null;

-- The remaining hole: removing ONE exercise from a day is still a hard delete
-- of a prescription, and if a set already points at it the same silent
-- severing happens on a smaller scale. A trigger refuses that, because the
-- alternative is trusting every present and future call site to check first —
-- and the cost of being wrong is measured in history nobody can rebuild.
--
-- A prescription nothing has been logged against deletes freely, which is the
-- ordinary case: editing a plan before training it.
create or replace function refuse_orphaning_logged_sets() returns trigger
  language plpgsql
  as $$
  begin
    if exists (select 1 from sets s where s.prescription_id = old.id) then
      -- RAISE ... USING takes expressions, not a format string plus args:
      -- the % substitution only exists in the non-USING form.
      raise exception using
        errcode = 'restrict_violation',
        message = format(
          'prescription %s has logged sets against it', old.id),
        hint = 'Discard the planned day instead (set discarded_at); sets '
               'keep the link that adherence is read from.';
    end if;
    return old;
  end
  $$;

-- Row-level, and NOT fired by the cascade from a planned_workouts delete:
-- there is no such delete any more. If one is ever performed by hand in psql,
-- this fires and refuses, which is the correct outcome.
create trigger prescriptions_keep_logged_history
  before delete on prescriptions
  for each row execute function refuse_orphaning_logged_sets();
