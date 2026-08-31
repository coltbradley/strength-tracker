-- A note that belongs to a MOVEMENT, not to one day of it.
--
-- Every other note in the system is scoped to an occasion: coach notes on a
-- planned day, the lifter's note on a day, a note on one logged set. None of
-- them carry "on Bulgarian split squats, front foot stays flat" — a cue that
-- is true every time that exercise comes up, and which currently has to be
-- retyped onto each day or forgotten.
--
-- NOT a column on `exercises`. That table is a shared library seeded from
-- free-exercise-db (CLAUDE.md): it never grows a per-user column, and never a
-- column the generated seed cannot populate, because 873 rows would sit null
-- forever and every re-seed would write it back. So the note lives beside it,
-- keyed by user AND exercise — the same shape and the same reasoning as
-- exercise_owners.
create table exercise_notes (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  exercise_id text not null references exercises (id) on delete cascade,
  note        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

comment on table exercise_notes is
  'One note per person per exercise: a cue that applies every time the '
  'movement comes up. Editable and last-write-wins, like set_notes and '
  'sessions.notes — the mutability class for a human annotation, never a way '
  'to edit the training record itself.';

alter table exercise_notes enable row level security;

-- Editable, unlike a set. Insert and update both prove ownership rather than
-- trusting the column default.
create policy exercise_notes_select on exercise_notes for select to authenticated
  using (user_id = auth.uid());
create policy exercise_notes_insert on exercise_notes for insert to authenticated
  with check (user_id = auth.uid());
create policy exercise_notes_update on exercise_notes for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No delete policy: clearing a note is writing an empty one, and the rows are
-- tiny. Same call as set_notes.
