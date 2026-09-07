-- A plan above the program.
--
-- The hierarchy stopped at `programs`, so every STRATEGIC fact about a lifter
-- -- where they are going over months, in what phases, with what emphasis and
-- what progression rule -- lived in a chat that is gone, or in `coach_memory`,
-- which is for standing facts about the PERSON and is capped at 300 characters
-- for a reason. The visible symptom was one program per coach screenshot:
-- "Coach -- Lower Strength (2026-08-27)", "Coach -- Lower + Activation
-- (2026-09-06)", one day each, because there was nothing above `programs` to
-- file a day under. Two months of that is sixteen one-day programs and a
-- list_programs result nobody can read.
--
-- A plan is the strategy. A program is a set of days; a day is a set of
-- prescriptions. `programs.phase_id` is the join that lets a parsed day be
-- filed under the phase it belongs to instead of minting a program per parse.
--
-- It is NOT goals: `goals` measures an e1RM target against real sets, and a
-- plan references goals rather than restating them. It is NOT memory: "left
-- shoulder impingement" is a fact about the body; "accumulation through
-- October, then four weeks of intensification" is a decision about time.

create table training_plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  objective     text not null check (length(trim(objective)) between 1 and 1000),
  starts_on     date not null,
  ends_on       date not null,
  source_note   text check (source_note is null or length(source_note) <= 120),
  created_at    timestamptz not null default now(),
  -- Unconfirmed until the user approves it in chat, like programs, and for a
  -- stronger version of the same reason: a plan steers every FUTURE write.
  confirmed_at  timestamptz,
  -- The soft-delete idiom for this table. A revision is a NEW row with the
  -- old one superseded, so the history of the strategy is append-only like
  -- everything else here. Never a hard delete: there is no delete policy.
  superseded_at timestamptz,
  check (ends_on >= starts_on)
);

comment on table training_plans is
  'The long-term STRATEGY for one lifter: an objective over months, split '
  'into dated phases (plan_phases). Written rarely and revised deliberately, '
  'from Claude Desktop through the MCP server; the in-app coach reads it on '
  'every turn and cannot write it. One live plan per user (superseded_at is '
  'null); a revision is a new row and the old one is superseded, never '
  'deleted. Lands unconfirmed (confirmed_at) like programs.';

comment on column training_plans.superseded_at is
  'Soft delete, this table''s answer to programs.discarded_at: set when a '
  'newer plan replaced this one. A superseded plan leaves every read but '
  'stays in Postgres, and the programs filed under its phases keep their '
  'phase_id, so the history of what was planned survives the revision.';

-- One live plan per user. The partial unique index IS the rule: a second row
-- with superseded_at null for the same user is refused by Postgres, whichever
-- path wrote it.
create unique index idx_training_plans_live
  on training_plans (user_id) where superseded_at is null;

create table plan_phases (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  plan_id              uuid not null references training_plans (id) on delete cascade,
  position             int not null check (position >= 0),
  name                 text not null check (length(trim(name)) between 1 and 60),
  starts_on            date not null,
  ends_on              date not null,
  focus                text check (focus is null or length(focus) <= 300),
  progression          text check (progression is null or length(progression) <= 300),
  sessions_per_week    int check (sessions_per_week between 1 and 14),
  -- Exercise ids, not a join table: a phase names a handful of lifts it is
  -- built around and nothing joins THROUGH them. Validated in code against the
  -- library the writer can see (visibleExerciseIds); an array cannot carry a
  -- foreign key, so a movement deleted later simply stops resolving to a name.
  primary_exercise_ids text[] not null default '{}',
  notes                text check (notes is null or length(notes) <= 1000),
  created_at           timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (plan_id, position)
);

comment on table plan_phases is
  'One dated block of a training plan: "Accumulation, 2026-09-01 to '
  '2026-10-12, hypertrophy on the squat pattern, add 2.5 kg when every '
  'working set hits the top of the range". Ordered by position, and phases of '
  'one plan may not overlap (plan_phases_no_overlap). programs.phase_id files '
  'a program under one of these so a parsed day joins the phase''s program '
  'instead of minting a program per screenshot.';

comment on column plan_phases.focus is
  'What this phase is FOR, in the coach''s words: "hypertrophy on the squat '
  'pattern, maintain pull". Read by the in-app coach on every turn; a day '
  'written or edited must fit it.';

comment on column plan_phases.progression is
  'The rule for moving load or volume inside this phase: "add 2.5 kg when '
  'every working set hits the top of the range". A rule, not a number: the '
  'numbers live in prescriptions.';

create index idx_plan_phases_plan on plan_phases (plan_id, position);

-- Phases of one plan may not share a day.
--
-- The natural spelling is an exclusion constraint:
--   exclude using gist (plan_id with =, daterange(starts_on, ends_on, '[]') with &&)
-- which needs btree_gist for the uuid equality half. This repository's
-- validation path is the migration chain run in PGlite (scripts/validate-db.mjs
-- and scripts/check-selects.mjs), and PGlite does not ship btree_gist as a
-- loadable extension: `create extension btree_gist` fails there unless the
-- harness is constructed with the contrib module, which changes both scripts
-- and CI, not this file. A trigger states the same rule in SQL both places can
-- run. It is AFTER ROW, not BEFORE: after-row triggers fire once the statement
-- has inserted every row, so two overlapping phases arriving in ONE bulk insert
-- -- which is how set_training_plan writes them -- are caught as well as two
-- arriving separately. The SQLSTATE is the one an exclusion constraint would
-- raise (23P01), so a caller cannot tell the difference and would not need to.
--
-- What the trigger does not do that the constraint would: take a lock that
-- serialises two concurrent writers of the same plan. Phases are written in
-- one statement by the tool that creates the plan they belong to, and that
-- plan is unique per user by the index above, so there is no second writer to
-- race. If that ever changes, a migration adds the constraint (with the
-- extension) and drops this; the rule does not change.
create or replace function refuse_overlapping_phases() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  begin
    if exists (
      select 1
        from plan_phases p
       where p.plan_id = new.plan_id
         and p.id <> new.id
         and daterange(p.starts_on, p.ends_on, '[]')
             && daterange(new.starts_on, new.ends_on, '[]')
    ) then
      raise exception using
        errcode = 'exclusion_violation',
        message = format(
          'phase "%s" (%s to %s) overlaps another phase of the same plan',
          new.name, new.starts_on, new.ends_on),
        hint = 'Phases of one plan may not share a day. End each phase the '
               'day before the next one starts.';
    end if;
    return new;
  end
  $$;

create trigger plan_phases_no_overlap
  after insert or update of plan_id, starts_on, ends_on on plan_phases
  for each row execute function refuse_overlapping_phases();

-- The join that stops one-program-per-screenshot. Nullable: every program that
-- exists today predates plans, and the app's own programs need no phase. ON
-- DELETE SET NULL rather than CASCADE, because a program is training the user
-- may have done and a plan is a document about it; if a plan were ever removed
-- by hand in psql, the programs must survive it.
alter table programs
  add column phase_id uuid references plan_phases (id) on delete set null;

comment on column programs.phase_id is
  'The plan phase this program belongs to, or null for a program written '
  'before plans existed or outside one. upsert_program with a phase_id adds '
  'days to the phase''s live program instead of creating another; get_program '
  'and list_programs show the phase by name.';

create index idx_programs_phase on programs (phase_id)
  where phase_id is not null and discarded_at is null;

-- RLS. Owner read; owner insert and update, so the PWA can show the plan today
-- and edit it later without a migration standing in the way. NO delete policy
-- on either table, on purpose: the absence of a policy is how this schema
-- says append-only (sets, sessions, set_voids, and since 20260905010000
-- programs). A plan is retired by superseding it; a phase has no life outside
-- its plan.
alter table training_plans enable row level security;
alter table plan_phases    enable row level security;

create policy training_plans_select on training_plans
  for select to authenticated using (user_id = auth.uid());
create policy training_plans_insert on training_plans
  for insert to authenticated with check (user_id = auth.uid());
create policy training_plans_update on training_plans
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy plan_phases_select on plan_phases
  for select to authenticated using (user_id = auth.uid());
create policy plan_phases_insert on plan_phases
  for insert to authenticated with check (user_id = auth.uid());
create policy plan_phases_update on plan_phases
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
