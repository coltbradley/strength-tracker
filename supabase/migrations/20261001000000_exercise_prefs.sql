-- Per-exercise presentation preferences that follow the lifter across devices.
--
-- Until now every per-exercise override (`ExercisePref` in
-- pwa/src/lib/settings.ts) lived only in the phone's localStorage, by an
-- explicit decision (docs/decisions.md, "Settings became a typed registry, and
-- got no database table"). The lifter has now explicitly asked for the
-- opposite for THIS record: the base weight of a bar or a machine's sled, the
-- plates-vs-stack choice and one-vs-two dumbbells should be set once and be
-- true on every device they sign in on. See docs/decisions.md 2026-10-01.
--
-- PRESENTATION ONLY. Nothing here is a training fact and nothing here may ever
-- change `load_kg`, which stays the TOTAL system load regardless of any value
-- in this table. `bar_kg` is the base the plate calculator subtracts before it
-- draws plates; `load_entry` is how a number is TYPED ("30 x 2" vs "60");
-- `load_style` is what the calculator draws. No view, no derived metric and no
-- MCP tool reads this table, and none should: a coach that reasoned from a
-- display preference would be reasoning from how a number was shown rather
-- than from what was lifted.
--
-- NOT a column on `exercises`. That library is shared and seeded and never
-- grows a column whose value differs per viewer (AGENTS.md). The row lives
-- beside it keyed (user_id, exercise_id), the exercise_notes shape.
--
-- Write ownership: the PWA ONLY, through its outbox, under owner RLS. The MCP
-- server (service role) never writes it.
--
-- Global device settings (plate inventory, bar inventory, display unit, load
-- steps, rest defaults, ...) are NOT here and stay device-local: those are
-- properties of the phone and the gym it walks into.
--
-- Conflict policy is last-write-wins on a CLIENT-stamped `updated_at`. The
-- outbox replays an upsert that merges on (user_id, exercise_id); the trigger
-- below drops an UPDATE whose `updated_at` is older than the stored one, so an
-- offline phone replaying yesterday's choice cannot clobber the one made on
-- another device this morning, and replaying the same write twice is a no-op
-- (idempotent replay, as for every other queued write). It is enforced here
-- rather than in the client because PostgREST's upsert cannot express a
-- conditional DO UPDATE, and because the PWA is not the boundary.
--
-- Clearing a preference writes a TOMBSTONE (every value column null, with a
-- fresh `updated_at`) rather than deleting the row; see the no-delete-policy
-- note at the bottom.

create table exercise_prefs (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- cascade, not restrict: a preference must never be the reference that
  -- stops delete_exercise from removing an otherwise unused custom exercise.
  exercise_id  text not null references exercises (id) on delete cascade,
  -- Bounds mirror parseExercisePrefs in pwa/src/lib/settings.ts (MAX_BAR_KG,
  -- MAX_REST_SECONDS, MAX_PLATE_KG). double precision, not numeric(6,2): the lb
  -- catalogue stores 45 lb as 20.4116... kg and the value must round-trip to
  -- exactly the float the device chose, or a bar chip stops reading selected.
  -- The upper bounds also reject NaN (NaN sorts above every number here).
  bar_kg       double precision check (bar_kg >= 0 and bar_kg <= 500),
  rest_seconds integer check (rest_seconds between 0 and 3600),
  load_step_kg double precision check (load_step_kg > 0 and load_step_kg <= 100),
  load_unit    text check (load_unit in ('kg', 'lb')),
  load_entry   text check (load_entry in ('total', 'per_side')),
  load_style   text check (load_style in ('plates', 'stack')),
  -- Finite only: 'infinity' would beat every later write and parses to NaN on
  -- the client. The upper bound (now() + 1 day) is a trigger, below, because a
  -- CHECK may not be relied on to stay valid as time passes.
  updated_at   timestamptz not null
    check (updated_at > '-infinity' and updated_at < 'infinity'),
  primary key (user_id, exercise_id)
);

comment on table exercise_prefs is
  'Per-person, per-exercise PRESENTATION preferences (base weight, load entry, '
  'plates vs stack, rest, step, unit), synced across devices. Last-write-wins '
  'on a client-stamped updated_at. Never affects load_kg; no view or MCP tool '
  'reads it. All-null value columns are a tombstone (the preference was cleared).';

-- FK lookup for the cascade from exercises (the fk_indexes precedent).
create index idx_exercise_prefs_exercise on exercise_prefs (exercise_id);

-- Two guards on every write, in one trigger function:
--
-- 1. updated_at may not be more than a day ahead of the server's clock. With
--    no bound, one write stamped 9999-12-31 (a phone with a wrong clock, a
--    client bug) beat every later write for ever, and with no delete policy
--    nothing could undo it. A day tolerates ordinary skew; anything beyond is
--    refused with 23514, which the outbox treats as a permanent rejection.
--
-- 2. Last-write-wins: an older write never replaces a newer one. Returning
--    NULL from a BEFORE UPDATE trigger skips the row silently, which is what an
--    idempotent replay wants: no error, so the outbox does not dead-letter a
--    write that simply lost the race. EQUAL stamps are broken by VALUE, so two
--    devices that stamped the same millisecond with different choices settle
--    on the same one everywhere: absent (null) sorts lowest, then bar_kg,
--    rest_seconds, load_step_kg numerically, then load_unit, load_entry,
--    load_style as text. comparePrefValues in
--    pwa/src/lib/exercisePrefsSync.ts mirrors this order exactly.
--
-- search_path is pinned to public, pg_temp like every other function
-- (docs/security.md): pg_temp is otherwise searched FIRST.
create function exercise_prefs_lww() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  if new.updated_at > now() + interval '1 day' then
    raise exception 'exercise_prefs.updated_at is more than a day in the future'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;
    end if;
    if new.updated_at = old.updated_at
       and (coalesce(new.bar_kg, -1), coalesce(new.rest_seconds, -1),
            coalesce(new.load_step_kg, -1), coalesce(new.load_unit, ''),
            coalesce(new.load_entry, ''), coalesce(new.load_style, ''))
        <= (coalesce(old.bar_kg, -1), coalesce(old.rest_seconds, -1),
            coalesce(old.load_step_kg, -1), coalesce(old.load_unit, ''),
            coalesce(old.load_entry, ''), coalesce(old.load_style, ''))
    then
      return null;
    end if;
  end if;
  return new;
end;
$$;

create trigger exercise_prefs_lww
  before insert or update on exercise_prefs
  for each row execute function exercise_prefs_lww();

alter table exercise_prefs enable row level security;

-- Owner-only, and insert/update both prove ownership rather than trusting the
-- column default (the exercise_notes pattern).
create policy exercise_prefs_select on exercise_prefs for select to authenticated
  using (user_id = auth.uid());
--
-- And the exercise must be VISIBLE to the caller. The FK's own check bypasses
-- RLS, so without this an insert for a guessable id (ids are name slugs) said
-- "success" for another user's private custom exercise and "23503" for a
-- missing one: an existence oracle, and a row of mine pointing at their
-- exercise. The subquery runs under the caller's RLS, so `exercises_read`
-- (source <> 'custom' or an exercise_owners row for me) decides, and
-- another person's private exercise fails EXACTLY like a nonexistent id: the
-- policy refuses (42501) before the FK is ever consulted.
create policy exercise_prefs_insert on exercise_prefs for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from exercises e where e.id = exercise_id)
  );
create policy exercise_prefs_update on exercise_prefs for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from exercises e where e.id = exercise_id)
  );

-- NO delete policy, deliberately, although this is the kind of row that would
-- otherwise qualify (a preference, not the training record, like coach_memory
-- or bodyweight_log). Under last-write-wins a hard delete leaves nothing to
-- compare against: a second device still holding the old preference sees "no
-- server row", reads its own copy as newer, and uploads it back. Clearing is
-- therefore a tombstone row with a fresh updated_at, which every device can
-- order. The row holds no personal content beyond the preference itself, it
-- goes with the account (on delete cascade from auth.users), and it goes with
-- a deleted custom exercise (on delete cascade from exercises).
