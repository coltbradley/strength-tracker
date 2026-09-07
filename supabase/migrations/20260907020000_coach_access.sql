-- Turning the in-app coach OFF for one person.
--
-- `COACH_ALLOWED_USERS` already gates the coach, but it is an ALLOWLIST in an
-- environment variable, and that is the wrong shape for "switch this one person
-- off". To disable one user you have to enumerate everyone else, set the
-- secret, and redeploy the function; get the list wrong and you have silently
-- locked out somebody you meant to keep. It also lives outside the database, so
-- nothing the app reads can know about it, and the person keeps seeing a chat
-- button that answers 403.
--
-- So: one row per user, written by whoever runs the deployment.
--
-- The two mechanisms stay separate on purpose and both must pass. The env var
-- is the DOOR — it is checked before any database read, it exists so an open
-- sign-up cannot mint accounts that spend the owner's Anthropic key, and its
-- job is to be cheap and to work when nothing else does. This table is the
-- SWITCH: per person, reversible, auditable, and readable by the app so the
-- entrance can be hidden rather than left to fail.
create table coach_access (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  enabled    boolean not null default true,
  -- Shown to the person, so write it for them and not for the log: "paused
  -- while we sort out the API bill" beats "disabled".
  reason     text check (reason is null or length(reason) <= 200),
  updated_at timestamptz not null default now(),
  -- Audit only. No policy and no read may branch on this; it answers "who
  -- turned this off", never "whose row is this", which is the distinction
  -- `source` failed to make on `exercises` and `updated_by` was added there to
  -- keep straight.
  updated_by uuid references auth.users (id) on delete set null
);

comment on table coach_access is
  'Per-user switch for the in-app coach. NO ROW MEANS ENABLED: this table lands '
  'on a running deployment and must not turn the coach off for everyone the '
  'moment it exists. Written by the service role only; the owner may read their '
  'own row so the app can hide the entrance instead of showing a button that '
  'answers 403.';

comment on column coach_access.enabled is
  'false disables the in-app coach for this user. The MCP server is NOT '
  'affected: a disabled user with a bearer token still reads and writes their '
  'own log from Claude Desktop. This switch is about who spends the '
  'deployment''s Anthropic key, not about who owns their data.';

alter table coach_access enable row level security;

-- Read your own row, and only your own. The app needs this to hide the chat
-- button; a person being able to see that they are switched off, and why, is
-- the point of the `reason` column.
create policy coach_access_select on coach_access
  for select to authenticated using (user_id = auth.uid());

-- NO insert, update or delete policies. This is the `push_config` / `mcp_tokens`
-- pattern: the absence of a policy is how this schema says "service role only".
--
-- It matters more here than it looks. `user_config` would have been the obvious
-- home for this column, and it is the wrong one: that table carries an owner
-- UPDATE policy so a user can set their own timezone, and a person who can
-- update their own row can switch their own coach back on. A setting the
-- subject can overrule is not an administrative control. Same reason this is
-- not a device-local setting.

-- Enabled unless a row says otherwise. In SQL rather than in three call sites,
-- so the PWA, the edge function and anyone poking at psql get the same answer,
-- the way app_tz() made "what day is it" answer the same everywhere.
-- SECURITY INVOKER, deliberately, which is the opposite of what a gate usually
-- wants. Definer would make this a public probe: any authenticated caller could
-- pass someone else's uuid and learn whether their coach is on. As invoker it
-- reads through RLS, so a user asking about anybody but themselves sees no row
-- and gets the default `true` -- a useless answer rather than a leak -- while
-- the service role bypasses RLS and gets the real one. The gate is enforced by
-- the edge function, which runs as the service role; this exists so the PWA and
-- psql agree with it instead of each spelling the default themselves.
create or replace function coach_enabled(p_user_id uuid) returns boolean
  language sql
  stable
  set search_path = public, pg_temp
  as $$
    select coalesce(
      (select enabled from coach_access where user_id = p_user_id),
      true
    );
  $$;

comment on function coach_enabled(uuid) is
  'Whether the in-app coach is on for one user. True when no row exists, which '
  'is the default state and the reason adding this table changed nothing for '
  'anyone already using the deployment. SECURITY INVOKER: asking about another '
  'user reads nothing through RLS and returns the default, not their answer.';

-- anon has no business asking. authenticated and service_role keep the default
-- grant, the same shape as the app_tz functions.
revoke execute on function coach_enabled(uuid) from anon;
