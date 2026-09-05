-- Bodyweight without a session.
--
-- `sessions.bodyweight_kg` has existed since the first schema and is captured
-- on the End screen. In a month of real use it was written zero times, because
-- End is only reached by tapping Finish, and someone who trains and walks away
-- never sees it. Meanwhile the number matters most on the days there is no
-- session at all.
--
-- So bodyweight gets its own row, decoupled from training, and the two sources
-- are reconciled in a view rather than by migrating the old column away:
-- `sessions.bodyweight_kg` keeps working, keeps its meaning, and anything that
-- wants the series reads v_bodyweight.

create table bodyweight_log (
  -- Client-generated, like every other queued write, so a replayed insert is
  -- idempotent under `on conflict do nothing` rather than a second weigh-in.
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  measured_at timestamptz not null default now(),
  weight_kg   numeric(5,2) not null check (weight_kg > 0),
  created_at  timestamptz not null default now()
);

comment on table bodyweight_log is
  'Bodyweight measurements that do not belong to a training session. Read '
  'through v_bodyweight, which unions these with the per-session figure, '
  'rather than directly: a caller that reads only one source silently answers '
  'the wrong question about the weeks the other one covers.';

create index idx_bodyweight_user on bodyweight_log (user_id, measured_at desc);

alter table bodyweight_log enable row level security;

create policy bw_select on bodyweight_log for select to authenticated
  using (user_id = auth.uid());
create policy bw_insert on bodyweight_log for insert to authenticated
  with check (user_id = auth.uid());

-- Unlike a set, this row is EDITABLE and DELETABLE, and the distinction is not
-- a softening of the append-only rule. A set is a training record: other rows
-- point at it, views derive from it, and a correction has to stay visible,
-- which is why voids exist. A weigh-in has no dependents at all, no void
-- mechanism, and no historical value once it is known to be wrong. A mistyped
-- 700 kg would otherwise sit in the trend forever with no way to say so.
create policy bw_update on bodyweight_log for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy bw_delete on bodyweight_log for delete to authenticated
  using (user_id = auth.uid());

-- One series, two origins, and the origin is exposed rather than hidden: a
-- reader showing "weighed in before training" wants to know which, and a
-- writer deciding whether today already has a figure needs to see both.
-- Discarded sessions leave, the same as everywhere else.
create view v_bodyweight with (security_invoker = true) as
select b.user_id, b.measured_at, b.weight_kg, 'log'::text as source, b.id as source_id
from bodyweight_log b
union all
select s.user_id, coalesce(s.ended_at, s.started_at), s.bodyweight_kg, 'session'::text, s.id
from sessions s
where s.bodyweight_kg is not null
  and s.discarded_at is null;

comment on view v_bodyweight is
  'Every bodyweight figure this person has recorded, from the standalone log '
  'and from sessions, newest-first when ordered by measured_at. source tells '
  'them apart; source_id is the row it came from in whichever table.';
