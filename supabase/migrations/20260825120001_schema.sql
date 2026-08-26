-- Schema: strength log core tables.
-- PLANNED tables (programs/planned_workouts/prescriptions) are written by Claude
-- via MCP. ACTUAL tables (sessions/sets) are written by the PWA only.
-- All loads are kg; display conversion is client-side.

create type set_type as enum ('warmup', 'working', 'backoff');

-- The user's home timezone for calendar bucketing (dates, ISO weeks) in the
-- derived-metric views. Set once per deployment:
--   alter database postgres set app.tz to 'America/Los_Angeles';
-- Falls back to UTC when unset so views never error.
create function app_tz() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('app.tz', true), ''), 'UTC') $$;

-- Global exercise library, seeded from yuhonas/free-exercise-db (Unlicense).
-- id is the upstream slug (e.g. 'Barbell_Squat'); custom entries use source='custom'.
create table exercises (
  id               text primary key check (id ~ '^[0-9a-zA-Z_-]+$'),
  name             text not null,
  primary_muscles  text[] not null default '{}',
  secondary_muscles text[] not null default '{}',
  equipment        text,
  mechanic         text check (mechanic in ('compound', 'isolation')),
  force            text check (force in ('push', 'pull', 'static')),
  category         text,
  level            text,
  source           text not null default 'free-exercise-db',
  created_at       timestamptz not null default now()
);

create table training_maxes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  exercise_id    text not null references exercises (id),
  value_kg       numeric(6,2) not null check (value_kg > 0),
  effective_date date not null default current_date,
  created_at     timestamptz not null default now(),
  unique (user_id, exercise_id, effective_date)
);

create table goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  exercise_id    text not null references exercises (id),
  target_e1rm_kg numeric(6,2) not null check (target_e1rm_kg > 0),
  target_date    date,
  created_at     timestamptz not null default now(),
  -- one goal per exercise; set_goal upserts on this, and it makes concurrent
  -- writes converge instead of duplicating
  unique (user_id, exercise_id)
);

-- PLANNED ------------------------------------------------------------------

create table programs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  source_note  text,
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);

create table planned_workouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  program_id uuid not null references programs (id) on delete cascade,
  day_index  int not null check (day_index >= 0),
  label      text,
  notes      text,
  unique (program_id, day_index)
);

create table prescriptions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  planned_workout_id uuid not null references planned_workouts (id) on delete cascade,
  exercise_id        text not null references exercises (id),
  position           int not null check (position >= 0),
  sets               int not null check (sets between 1 and 20),
  reps_min           int not null check (reps_min between 1 and 100),
  reps_max           int not null check (reps_max >= reps_min),
  load_kg            numeric(6,2) check (load_kg > 0),
  load_pct_tm        numeric(5,2) check (load_pct_tm > 0 and load_pct_tm <= 200),
  rest_seconds       int check (rest_seconds between 0 and 3600),
  notes              text,
  -- absolute load or %TM, never both; both null means coach said "by feel"
  check (load_kg is null or load_pct_tm is null),
  unique (planned_workout_id, position)
);

-- ACTUAL -------------------------------------------------------------------
-- ids are client-generated UUIDs so the offline queue can replay
-- idempotently with `on conflict do nothing`.

create table sessions (
  id                 uuid primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  planned_workout_id uuid references planned_workouts (id) on delete set null,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  session_rpe        smallint check (session_rpe between 0 and 10),
  bodyweight_kg      numeric(5,2) check (bodyweight_kg > 0),
  notes              text,
  check (ended_at is null or ended_at >= started_at)
);

create table sets (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id      uuid not null references sessions (id) on delete cascade,
  exercise_id     text not null references exercises (id),
  prescription_id uuid references prescriptions (id) on delete set null,
  set_index       int not null check (set_index >= 0),
  set_type        set_type not null default 'working',
  load_kg         numeric(6,2) not null check (load_kg >= 0),  -- 0 = bodyweight
  reps            int not null check (reps between 0 and 100),
  -- rest observed by the in-app timer BEFORE this set (i.e. after the previous
  -- one). Stamped at insert time, so append-only holds; v_rest stays the
  -- timestamp-derived fallback. Null for the first set and for old rows.
  rest_seconds_actual int check (rest_seconds_actual between 0 and 3600),
  performed_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- Indexes ------------------------------------------------------------------

create index idx_tm_lookup        on training_maxes (user_id, exercise_id, effective_date desc);
create index idx_goals_user       on goals (user_id, exercise_id);
create index idx_pw_program       on planned_workouts (program_id, day_index);
create index idx_rx_workout       on prescriptions (planned_workout_id, position);
create index idx_sessions_user    on sessions (user_id, started_at desc);
create index idx_sets_session     on sets (session_id, performed_at);
create index idx_sets_history     on sets (user_id, exercise_id, performed_at desc);
