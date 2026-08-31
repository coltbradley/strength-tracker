-- The in-app coach: short-lived credentials and a spend ceiling.
--
-- The coach is an edge function that calls the Anthropic API on the user's
-- behalf and gives it the EXISTING MCP server as its tool surface. Two things
-- have to exist in the database for that to be safe.

-- 1. Tokens that die on their own.
--
-- The coach cannot use a long-lived MCP token: the Anthropic API needs a
-- bearer token to reach the MCP server, and mcp_tokens stores only SHA-256
-- digests, so there is no plaintext to hand it. The function therefore mints a
-- fresh token per conversation turn. Without an expiry those would accumulate
-- forever as live credentials — one per message ever sent.
--
-- Null means "does not expire", which is every token issued by
-- scripts/issue-mcp-token.mjs. Only the coach sets this.
alter table mcp_tokens add column expires_at timestamptz;

comment on column mcp_tokens.expires_at is
  'When set, the token stops authenticating after this instant. Used by the '
  'coach edge function, which mints one per turn and lets it die minutes '
  'later. Null (the default) is a permanent token, which is what a person '
  'pastes into an MCP client.';

-- Sweeping is cheap and keeps the table honest. Called by the coach function
-- on each mint, so there is no cron to forget.
create or replace function purge_expired_mcp_tokens() returns void
language sql security definer set search_path = public as $$
  delete from mcp_tokens where expires_at is not null and expires_at < now() - interval '1 day';
$$;

-- 2. A ceiling on what the coach can spend.
--
-- The API key belongs to the deployment owner, not to the person chatting. An
-- authenticated user could otherwise run the bill up without limit, whether on
-- purpose or by leaving a retry loop running. One row per turn: enough to
-- window a rate limit, and an itemised record of what was actually spent.
create table coach_usage (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  model         text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  -- Set when the turn was refused, so a rejected request still leaves a trace.
  refused       text
);

create index idx_coach_usage_user_time on coach_usage (user_id, created_at desc);

alter table coach_usage enable row level security;
-- Readable by its owner so the app can show "you have N messages left today".
-- Never writable from a client: the edge function writes it with the service
-- role, and a client that could insert its own usage rows could also not
-- insert them.
create policy coach_usage_select on coach_usage for select to authenticated
  using (user_id = auth.uid());
