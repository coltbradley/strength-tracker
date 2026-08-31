-- Somewhere for Claude to put "I could not do that".
--
-- The MCP server has no way to report a gap. When a tool is missing, a
-- prescription cannot be expressed, or a parse hits a shape the schema does
-- not carry, the only outcome is a sentence in a chat window that nobody ever
-- reads again. This is the table that outlives the conversation.
--
-- Append-mostly by design: entries are inserted and can be resolved, never
-- edited. What was asked for is a record, not a draft.
create table feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('feature', 'bug', 'data_gap', 'question')),
  title       text not null check (length(trim(title)) between 1 and 200),
  detail      text,
  -- What the assistant was trying to do when it hit this. The single most
  -- useful field: a request without its context is a wish, with it a spec.
  context     text,
  -- 'claude' when a tool wrote it, 'user' when the app did. Not a trust
  -- boundary, just provenance for reading the list later.
  source      text not null default 'claude' check (source in ('claude', 'user')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index idx_feedback_user on feedback (user_id, created_at desc);
create index idx_feedback_open on feedback (user_id) where resolved_at is null;

alter table feedback enable row level security;

-- Owner-only, like everything else. Insert proves ownership rather than
-- trusting the default, so a client cannot file against another user.
create policy feedback_select on feedback for select to authenticated
  using (user_id = auth.uid());
create policy feedback_insert on feedback for insert to authenticated
  with check (user_id = auth.uid());
-- Resolving is the one mutation. No delete policy: a request you decided
-- against is answered by resolving it, and the record of having asked stays.
create policy feedback_update on feedback for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
