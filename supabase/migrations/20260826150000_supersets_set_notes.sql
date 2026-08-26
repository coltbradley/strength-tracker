-- Supersets + per-set notes (all additive; see docs/decisions.md 2026-08-26
-- design round).
--
-- 1. prescriptions.superset_group: exercises sharing a group number in the
--    same workout are a superset (1 = A, 2 = B, ...). Display-only grouping;
--    nothing is enforced at log time.
-- 2. set_notes: the user's annotation on one logged set. Sets themselves
--    stay append-only; notes are a separate user-owned row that may be
--    edited (same mutability class as sessions.notes). Written by the PWA
--    only, like everything set-shaped.

-- 1. supersets ----------------------------------------------------------------

alter table prescriptions add column superset_group smallint
  check (superset_group between 1 and 26);

-- expose it to the app (create or replace: same columns, new one appended)
create or replace view v_resolved_prescriptions with (security_invoker = true) as
select
  p.id, p.user_id, p.planned_workout_id, p.exercise_id, e.name as exercise_name,
  p.position, p.sets, p.reps_min, p.reps_max, p.rest_seconds, p.notes,
  p.load_kg, p.load_pct_tm, tm.value_kg as tm_kg,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as resolved_load_kg,
  round(coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) / 2.5) * 2.5 as plate_load_kg,
  p.superset_group
from prescriptions p
join exercises e on e.id = p.exercise_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id;

-- 2. set notes ----------------------------------------------------------------

create table set_notes (
  set_id     uuid primary key references sets (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note       text not null,
  updated_at timestamptz not null default now()
);

alter table set_notes enable row level security;
-- notes are editable (unlike sets); insert proves the set is the caller's
-- own (the FK alone would not: FK checks bypass RLS). No delete policy —
-- clearing a note is writing an empty-trimmed note away client-side, and
-- rows are tiny.
create policy set_notes_select on set_notes for select to authenticated using (user_id = auth.uid());
create policy set_notes_insert on set_notes for insert to authenticated with check (
  user_id = auth.uid()
  and exists (select 1 from sets s where s.id = set_id and s.user_id = auth.uid())
);
create policy set_notes_update on set_notes for update to authenticated
  using (user_id = auth.uid())
  with check (
    -- same ownership proof as insert: a note can't be repointed at a set
    -- that isn't the caller's own
    user_id = auth.uid()
    and exists (select 1 from sets s where s.id = set_id and s.user_id = auth.uid())
  );
