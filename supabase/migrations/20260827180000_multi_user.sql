-- Multi-user. The schema was always per-user (every training table carries
-- user_id with RLS), but three things assumed exactly one person and one
-- credential. This migration closes all three. Nothing here is destructive:
-- an existing single-user deployment keeps working unchanged.
--
--   1. app_config.tz was ONE global row, so every user got one calendar.
--   2. exercises has no owner, so a custom exercise added by one person was
--      visible and editable by everyone.
--   3. the MCP server authenticated with one static secret mapped to one
--      OWNER_USER_ID, so any caller holding it WAS that user.

-- 1. per-user timezone --------------------------------------------------------
-- app_config.tz stays as the deployment-wide DEFAULT (and the answer for the
-- service-role path when no user is in scope). user_config overrides it per
-- person, so a couple in one house shares the default and a user who moves
-- changes only their own row.
create table user_config (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  tz      text not null,
  updated_at timestamptz not null default now()
);

alter table user_config enable row level security;
create policy user_config_select on user_config
  for select to authenticated using (user_id = auth.uid());
create policy user_config_insert on user_config
  for insert to authenticated with check (user_id = auth.uid());
create policy user_config_update on user_config
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The timezone for ONE user, falling back to the deployment default and then
-- UTC. Taking the user id as an argument (rather than reading auth.uid()
-- internally) is what makes this work on BOTH paths: the PWA runs views as the
-- authenticated user, and the MCP server runs as the service role where
-- auth.uid() is null but the row's own user_id is known.
create or replace function app_tz(p_user_id uuid) returns text
  language sql stable
  as $$
    select coalesce(
      (select tz from user_config where user_id = p_user_id),
      (select value from app_config where key = 'tz'),
      'UTC'
    )
  $$;

-- Unchanged signature, now user-aware. Anything still calling app_tz() with no
-- argument means "the caller", which is correct inside a security_invoker view
-- on the PWA path and correctly falls back to the deployment default when
-- there is no authenticated user.
create or replace function app_tz() returns text
  language sql stable
  as $$ select app_tz(auth.uid()) $$;

-- 2. views bucket by the ROW OWNER's timezone ---------------------------------
-- These three were the only app_tz() callers. Each now passes the user_id of
-- the row it is bucketing rather than asking who is asking: a training max
-- becomes effective in ITS OWNER's calendar, not in the calendar of whoever
-- happens to be running the query. That is also what makes the service-role
-- (MCP) path correct without impersonating anyone.
create or replace view v_current_tm with (security_invoker = true) as
select distinct on (user_id, exercise_id)
  user_id, exercise_id, value_kg, effective_date
from training_maxes
where effective_date <= (now() at time zone app_tz(user_id))::date
order by user_id, exercise_id, effective_date desc;

create or replace view v_weekly_volume with (security_invoker = true) as
select
  user_id, exercise_id,
  (date_trunc('week', performed_at at time zone app_tz(user_id)))::date as week_start,
  count(*) as working_sets,
  sum(load_kg * reps) as tonnage_kg
from v_live_sets
where set_type = 'working'
group by user_id, exercise_id, (date_trunc('week', performed_at at time zone app_tz(user_id)))::date;

create or replace view v_adherence with (security_invoker = true) as
select
  s.id as set_id, s.user_id, s.session_id, s.exercise_id,
  s.prescription_id, s.set_index, s.performed_at,
  s.load_kg as actual_load_kg, s.reps as actual_reps,
  p.reps_min, p.reps_max,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as prescribed_load_kg,
  s.load_kg - coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as load_delta_kg,
  case
    when s.reps < p.reps_min then 'missed'
    when s.reps > p.reps_max then 'exceeded'
    else 'hit'
  end as rep_outcome,
  s.load_entry as actual_load_entry,
  p.load_entry as prescribed_load_entry
from v_live_sets s
join prescriptions p on p.id = s.prescription_id
left join lateral (
  select t.value_kg
  from training_maxes t
  where t.user_id = s.user_id
    and t.exercise_id = s.exercise_id
    and t.effective_date <= (s.performed_at at time zone app_tz(s.user_id))::date
  order by t.effective_date desc
  limit 1
) tm on true
where s.set_type in ('working', 'backoff');

-- 3. custom exercises get an owner --------------------------------------------
-- CLAUDE.md forbids a per-user column on `exercises`: 873 generated rows would
-- carry a null forever and every re-seed would write it back. So ownership
-- lives beside the table. Seeded rows (free-exercise-db, curated) have no row
-- here and stay shared by everyone, which is right — they are a library, not
-- anyone's data.
create table exercise_owners (
  exercise_id text primary key references exercises (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index idx_exercise_owners_user on exercise_owners (user_id);

alter table exercise_owners enable row level security;
create policy exercise_owners_select on exercise_owners
  for select to authenticated using (user_id = auth.uid());
create policy exercise_owners_insert on exercise_owners
  for insert to authenticated with check (user_id = auth.uid());
create policy exercise_owners_delete on exercise_owners
  for delete to authenticated using (user_id = auth.uid());

-- Claiming is a trigger, not a second statement at each call site, so the
-- invariant "a custom exercise has an owner" cannot be forgotten by a new
-- writer. It fires only when there IS an authenticated user; the service-role
-- path (MCP add_exercise) has no auth.uid() and inserts the owner row itself.
create or replace function claim_custom_exercise() returns trigger
  language plpgsql
  as $$
  begin
    if new.source = 'custom' and auth.uid() is not null then
      insert into exercise_owners (exercise_id, user_id)
      values (new.id, auth.uid())
      on conflict (exercise_id) do nothing;
    end if;
    return new;
  end
  $$;

create trigger exercises_claim_custom
  after insert on exercises
  for each row execute function claim_custom_exercise();

-- Backfill BEFORE tightening the policy, so nothing a user already relies on
-- disappears. A custom exercise belongs to whoever actually used it; that is
-- deterministic and needs no guess about who "the" user is.
insert into exercise_owners (exercise_id, user_id)
select distinct on (e.id) e.id, r.user_id
from exercises e
join lateral (
                select user_id from sets            where exercise_id = e.id
  union all     select user_id from prescriptions   where exercise_id = e.id
  union all     select user_id from training_maxes  where exercise_id = e.id
  union all     select user_id from goals           where exercise_id = e.id
) r on true
where e.source = 'custom'
on conflict (exercise_id) do nothing;

-- Anything still unclaimed was created but never used. If this deployment has
-- exactly one account, it is unambiguously theirs; with more, leave it and let
-- a human decide rather than handing one person's row to another.
insert into exercise_owners (exercise_id, user_id)
select e.id, (select id from auth.users)
from exercises e
where e.source = 'custom'
  and (select count(*) from auth.users) = 1
on conflict (exercise_id) do nothing;

-- The library is shared; custom entries are personal.
drop policy exercises_read on exercises;
create policy exercises_read on exercises
  for select to authenticated using (
    source <> 'custom'
    or exists (
      select 1 from exercise_owners o
      where o.exercise_id = exercises.id and o.user_id = auth.uid()
    )
  );

-- Editing and deleting a custom exercise is owner-only. Previously neither
-- policy existed at all (only the service role could write), so this is new
-- capability for the PWA as well as a scoping rule.
create policy exercises_update_own_custom on exercises
  for update to authenticated
  using (
    source = 'custom'
    and exists (
      select 1 from exercise_owners o
      where o.exercise_id = exercises.id and o.user_id = auth.uid()
    )
  )
  with check (source = 'custom');

create policy exercises_delete_own_custom on exercises
  for delete to authenticated using (
    source = 'custom'
    and exists (
      select 1 from exercise_owners o
      where o.exercise_id = exercises.id and o.user_id = auth.uid()
    )
  );

-- 4. per-user MCP credentials --------------------------------------------------
-- The MCP server authenticates with a bearer token because its callers (Claude
-- Desktop, claude.ai, ChatGPT, any MCP client) send a static header, not a
-- Supabase session. One shared secret meant one identity. Now a token IS the
-- identity: the server hashes what it was given and looks the user up.
--
-- Only the SHA-256 of the token is stored, so a database leak does not hand
-- anyone a working credential. Tokens are minted by scripts/issue-mcp-token.mjs
-- and never travel through this table in plaintext.
--
-- RLS is on with NO policies on purpose: `authenticated` can neither read nor
-- write it. The service role (the edge function) bypasses RLS; a human uses the
-- SQL editor. A credential table is not app data.
create table mcp_tokens (
  token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
  user_id      uuid not null references auth.users (id) on delete cascade,
  label        text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index idx_mcp_tokens_user on mcp_tokens (user_id);

alter table mcp_tokens enable row level security;
