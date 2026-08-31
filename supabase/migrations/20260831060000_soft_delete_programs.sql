-- Nothing a model can reach should be unrecoverable.
--
-- `sets` are append-only, `sessions` soft-delete via discarded_at, corrections
-- go through set_voids — and then `programs`, the one table an LLM can write,
-- had a hard DELETE. A mis-parsed instruction or a misread "get rid of that"
-- destroyed a plan with no undo, in a codebase whose entire stated principle
-- is that the record survives.
--
-- This closes that. `delete_program` now sets discarded_at, exactly like
-- discarding a session, and the row and its whole tree stay in Postgres.
alter table programs add column discarded_at timestamptz;

comment on column programs.discarded_at is
  'Soft delete, matching sessions.discarded_at. A discarded program leaves '
  'every view — including the calendar, via v_plan_workouts — but stays in '
  'Postgres. There is no hard-delete path a client or a tool can reach.';

create index idx_programs_live on programs (user_id) where discarded_at is null;

-- The leak this has to close: a discarded program's planned_workouts are
-- untouched rows with real scheduled_dates, so without joining through to the
-- program they keep appearing on the calendar after the plan they belong to is
-- gone. v_plan_workouts is already the single place every plan read goes
-- (added with templates for exactly this reason), so the join belongs here
-- rather than in each caller.
create or replace view v_plan_workouts with (security_invoker = true) as
select w.id, w.user_id, w.program_id, w.day_index, w.label, w.notes,
       w.scheduled_date, w.plan_note, w.skipped_at
from planned_workouts w
join programs p on p.id = w.program_id
where not w.is_template
  and p.discarded_at is null;
