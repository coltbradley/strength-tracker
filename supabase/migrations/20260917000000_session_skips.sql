-- What the lifter decided not to do, kept as context rather than as a ratio.
--
-- Skips live in React state today (`skips`, cached under cacheKeys.sessionSkips
-- in IndexedDB) and never reach Postgres: four skipped exercises on a real
-- 9/16 session left nothing the coach could read afterward. This is the
-- append-only record, written once at Finish (`End.tsx`), one row per skipped
-- entry. Like `sets`, it is never updated or deleted: an un-skip during the
-- session is a client-side state change that never hits the network, because
-- the row is only written once the lifter is done deciding. A session that is
-- never finished loses its skips — accepted, and noted in docs/decisions.md,
-- the same trade `sets` already makes for anything logged and never synced.
--
-- Deliberately NOT a ratio input: `v_weekly_summary`'s adherence-percentage
-- ban (CLAUDE.md) applies here too. This table exists so the coach can say
-- "you skipped accessories twice this week, both times equipment was taken" —
-- never "80% completion".
create table session_skips (
  -- Client-generated, like every other queued write: idempotent replay via
  -- `on conflict do nothing`.
  id              uuid primary key,
  user_id         uuid not null default auth.uid()
                    references auth.users (id) on delete cascade,
  session_id      uuid not null references sessions (id),
  -- set null, not cascade: the day's plan can be edited or the prescription
  -- reshuffled after the skip is recorded, and the skip itself is a fact
  -- about what happened in the session, independent of whether the row it
  -- pointed at still exists. Compare `sets.prescription_id`, the same idiom.
  prescription_id uuid references prescriptions (id) on delete set null,
  -- text, matching exercises.id (a free-exercise-db slug, not a uuid).
  exercise_id     text not null references exercises (id),
  -- 'exercise' = the whole entry was skipped. 'warmups' = the working sets
  -- were done but the prescribed warmup brackets were not (paired with
  -- "Already warm" on the hero, spec: Session capture > Set type on the hero).
  scope           text not null check (scope in ('exercise', 'warmups')),
  reason          text check (length(reason) <= 200),
  created_at      timestamptz not null default now()
);

comment on table session_skips is
  'One row per skipped entry, written through the outbox when the lifter '
  'taps Finish. Append-only like sets: no update or delete policy. Context '
  'for the coach adapting the next session, never an adherence ratio — see '
  'v_weekly_summary''s planned_days / planned_days_done ban on the same '
  'thing (CLAUDE.md).';

comment on column session_skips.scope is
  'exercise = the whole entry was skipped. warmups = the working sets were '
  'logged but the prescribed warmup brackets were not, because the lifter '
  'tapped Already warm.';

comment on column session_skips.reason is
  'One of a closed set of reason chips the lifter tapped (Equipment taken, '
  'Already warm, Out of time, Didn''t feel right) or free text. Optional: '
  'nothing requires a reason to skip.';

create index idx_session_skips_session on session_skips (session_id);

alter table session_skips enable row level security;

-- Append-only: select + insert only, no update or delete policy, the same
-- shape as `sets` and `set_voids`. The insert check also proves the session
-- being skipped against is the caller's own (the FK alone would not: FK
-- checks bypass RLS).
create policy session_skips_select on session_skips for select to authenticated
  using (user_id = auth.uid());
create policy session_skips_insert on session_skips for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from sessions s where s.id = session_id and s.user_id = auth.uid())
  );
