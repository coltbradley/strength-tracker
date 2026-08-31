-- What the coach knows about the person, between conversations.
--
-- A thread remembers itself and nothing else: "New" wipes it, a second device
-- starts empty, and the lifter re-explains their shoulder every time. That is
-- the single most tiring thing about talking to an assistant, and it is not
-- something the training log can answer — no view holds "I train at 6am before
-- work" or "my left shoulder does not like overhead pressing".
--
-- Deliberately NOT a general note store, and deliberately NOT goals: `goals`
-- and v_goal_progress already exist and are measured against real sets, which
-- is a better record than a sentence. This is for the standing facts that
-- shape advice and cannot be derived from what was lifted.
create type memory_kind as enum ('injury', 'constraint', 'preference', 'context');

create table coach_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       memory_kind not null,
  fact       text not null check (length(trim(fact)) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table coach_memory is
  'Standing facts about the lifter that shape advice and cannot be derived '
  'from their log: injuries, equipment and schedule constraints, coaching '
  'preferences. Short by constraint (300 chars) because the value is being '
  'readable at a glance in every conversation, not holding everything.';

comment on column coach_memory.kind is
  'injury = something that hurts or is being worked around. constraint = a '
  'fact about their circumstances (equipment, schedule, travel). preference = '
  'how they want to be coached or train. context = anything else standing and '
  'relevant. NOT goals — the goals table measures those against real sets.';

create index idx_coach_memory_user on coach_memory (user_id, kind);

alter table coach_memory enable row level security;

-- Editable and deletable, unlike the training record: a fact that stops being
-- true is wrong, not history, and leaving it would make every future answer
-- worse. This is the sessions.notes mutability class, not the sets one.
create policy coach_memory_select on coach_memory for select to authenticated
  using (user_id = auth.uid());
create policy coach_memory_insert on coach_memory for insert to authenticated
  with check (user_id = auth.uid());
create policy coach_memory_update on coach_memory for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy coach_memory_delete on coach_memory for delete to authenticated
  using (user_id = auth.uid());
