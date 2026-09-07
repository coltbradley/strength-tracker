-- E0 of the endurance layer: endurance actuals become rows.
--
-- Plan: docs/endurance-plan.md. Spec: docs/superpowers/plans/
-- 2026-09-06-endurance-implementation-spec.md (which assigned this 20260906010000;
-- it is numbered later here so it applies after the two 2026-09-07 coach
-- migrations, since order on disk is the only order there is).
--
-- A THIRD WRITE-OWNERSHIP CLASS. `sets` are written by the PWA and nothing
-- else. Planned tables are written by the PWA and the MCP server. An
-- `activities` row is written by neither: it arrives from a sync against a
-- third party the user does not control and this deployment cannot fix. The
-- rule that falls out, and that every endurance phase re-checks, is that the
-- endurance half may never become a dependency of the strength half. Strength
-- data is the only copy of itself and is written by a phone in a basement.

create table activities (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source         text not null check (source in ('intervals_icu','strava','manual','fit_upload')),
  -- The id THIS source uses. Unique per (user, source) so a replayed sync
  -- writes nothing, the same guarantee `sets` gets from client-generated uuids.
  external_id    text not null,
  sport          text not null,
  started_at     timestamptz not null,
  elapsed_s      int  not null check (elapsed_s >= 0),
  moving_s       int  check (moving_s >= 0),
  distance_m     numeric(10,1) check (distance_m >= 0),
  -- Ascent and descent are SEPARATE columns and that is the point of this
  -- table. Nothing on the market stores loss: Runna's terrain field is a
  -- four-value enum about where you live, Uphill Athlete counts gain only,
  -- Vert.run's Mountain Index is gain-only density. Descent is what produces
  -- ~40% knee-extensor strength loss at the finish of a mountain ultra and it
  -- is what the eccentric block is dosed against. Nullable because a treadmill
  -- has none: null means unknown, never zero.
  ascent_m       numeric(8,1)  check (ascent_m >= 0),
  descent_m      numeric(8,1)  check (descent_m >= 0),
  avg_hr         smallint check (avg_hr between 20 and 250),
  max_hr         smallint check (max_hr between 20 and 250),
  avg_power_w    numeric(6,1) check (avg_power_w >= 0),
  avg_cadence    numeric(5,1) check (avg_cadence >= 0),
  -- Session-RPE is the one field-validated load method and the only unit that
  -- spans running and lifting. Its validity depends on WHEN it was collected
  -- (~30 min post), so the timestamp is part of the measurement rather than
  -- metadata: a row with an RPE and no timestamp is a row whose RPE cannot be
  -- trusted. Neither is ever inferred.
  perceived_rpe  smallint check (perceived_rpe between 0 and 10),
  rpe_recorded_at timestamptz,
  name           text check (name is null or length(name) <= 200),
  planned_workout_id uuid references planned_workouts (id) on delete set null,
  -- Two independent ways a row stops counting, and they are not the same fact.
  -- discarded_at is the soft-delete idiom this schema uses everywhere: the user
  -- said this is not training. duplicate_of says the SAME activity already
  -- exists from another source, which is what happens the moment both Strava
  -- and intervals.icu are connected and one Garmin upload reaches both. Marked
  -- rather than deleted, for the reason set_voids exists: the row is evidence,
  -- and the source-specific detail on it (Strava's segments, intervals.icu's
  -- streams) is still the only copy of itself.
  discarded_at   timestamptz,
  duplicate_of   uuid references activities (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (user_id, source, external_id),
  -- A row cannot be its own duplicate, which a naive matcher would otherwise
  -- write on a re-sync.
  check (duplicate_of is null or duplicate_of <> id)
);

comment on table activities is
  'Endurance actuals, synced from a third party. Append-only in practice: no '
  'delete policy, corrections are discarded_at, and a row that arrived twice '
  'from two sources is marked duplicate_of rather than removed. Written by the '
  'sync (service role) and annotated by its owner; never by the PWA the way '
  'sets are, and never a dependency of them.';

comment on column activities.duplicate_of is
  'Set when this row is the same real-world activity as another, already-held '
  'row from a different source. v_live_activities drops these, so weekly volume '
  'is not doubled by connecting two sources. The FIRST row held wins and later '
  'arrivals are marked, which makes the outcome independent of sync order.';

create index idx_activities_user_time on activities (user_id, started_at desc);
create index idx_activities_planned on activities (planned_workout_id)
  where planned_workout_id is not null;
-- The matcher's lookup: same user and sport, near the same instant.
create index idx_activities_dedup on activities (user_id, sport, started_at)
  where discarded_at is null and duplicate_of is null;

alter table activities enable row level security;

create policy activities_select on activities
  for select to authenticated using (user_id = auth.uid());

-- Insert is for the manual and fit_upload paths only. A user may not forge a
-- row claiming to have come from a sync: source is checked here, not trusted.
create policy activities_insert on activities
  for insert to authenticated
  with check (user_id = auth.uid() and source in ('manual','fit_upload'));

-- The owner ANNOTATES; the sync owns the measurements. Postgres has no
-- per-column update policy, so the columns a user may change are pinned by a
-- trigger below rather than wished for in a comment.
create policy activities_update on activities
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No delete policy. The soft-delete idiom, same as sessions, programs and
-- planned_workouts.

create or replace function refuse_activity_measurement_edits() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  begin
    -- The service role bypasses RLS and therefore reaches this trigger with
    -- auth.uid() null; that is the sync, and it may write anything.
    if auth.uid() is null then
      return new;
    end if;
    if new.source           is distinct from old.source
    or new.external_id      is distinct from old.external_id
    or new.started_at       is distinct from old.started_at
    or new.elapsed_s        is distinct from old.elapsed_s
    or new.moving_s         is distinct from old.moving_s
    or new.distance_m       is distinct from old.distance_m
    or new.ascent_m         is distinct from old.ascent_m
    or new.descent_m        is distinct from old.descent_m
    or new.avg_hr           is distinct from old.avg_hr
    or new.max_hr           is distinct from old.max_hr
    or new.avg_power_w      is distinct from old.avg_power_w
    or new.avg_cadence      is distinct from old.avg_cadence
    or new.duplicate_of     is distinct from old.duplicate_of
    then
      raise exception using
        errcode = 'insufficient_privilege',
        message = 'measurements come from the sync and are not editable',
        hint = 'A user may set perceived_rpe, rpe_recorded_at, name, '
               'planned_workout_id and discarded_at. To correct a measurement, '
               'fix it upstream and re-sync.';
    end if;
    return new;
  end
  $$;

create trigger activities_measurements_readonly
  before update on activities
  for each row execute function refuse_activity_measurement_edits();

-- The dedup rule lives HERE rather than in each sync, so a third source added
-- later cannot forget it and so it is testable without a running edge function.
--
-- The failure modes are not symmetrical, and that decides the thresholds. A
-- MISSED duplicate double-counts a week's volume: visible, annoying, and
-- fixable by hand later. A WRONG match hides a real training day from every
-- view that reads v_live_activities: silent, and the kind of thing someone
-- discovers months later wondering why a week looks light. So this matches
-- conservatively and would rather leave two rows than lose one.
--
-- Same person, DIFFERENT source (two rows from one source at the same instant
-- are that source's business and are probably real -- a split "Part 1 / Part 2"
-- run is a real pair), the same sport spelled the same way case-insensitively,
-- starting within two minutes, and lasting within the greater of 60 seconds or
-- 5% of each other. Both rows ultimately come from one device upload, so their
-- start times agree to the second in practice; two minutes is slack for
-- provider clock handling, not for guessing.
create or replace function mark_duplicate_activity() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  declare
    match_id uuid;
    new_dur  int := coalesce(new.moving_s, new.elapsed_s);
  begin
    if new.duplicate_of is not null then
      return new;   -- already decided by the caller; do not second-guess it
    end if;
    select a.id into match_id
      from activities a
     where a.user_id = new.user_id
       and a.source <> new.source
       and lower(a.sport) = lower(new.sport)
       and a.discarded_at is null
       and a.duplicate_of is null
       and a.started_at between new.started_at - interval '2 minutes'
                            and new.started_at + interval '2 minutes'
       and abs(coalesce(a.moving_s, a.elapsed_s) - new_dur)
             <= greatest(60, new_dur * 0.05)
     order by abs(extract(epoch from (a.started_at - new.started_at)))
     limit 1;

    -- The row already held wins and the later arrival is marked, which makes
    -- the outcome the same whichever sync ran first.
    new.duplicate_of := match_id;
    return new;
  end
  $$;

create trigger activities_dedup
  before insert on activities
  for each row execute function mark_duplicate_activity();

comment on function mark_duplicate_activity() is
  'Marks an incoming activity as duplicate_of an existing one from a DIFFERENT '
  'source when they are plainly the same effort. Conservative on purpose: a '
  'missed duplicate double-counts a week and is visible, a wrong match hides a '
  'real training day and is not.';

-- Credentials for the syncs. One row per user per provider, service role only:
-- RLS on, NO policies, the push_config pattern. These are bearer tokens to
-- somebody's whole training history and no client has any reason to read them.
create table integration_credentials (
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (provider in ('intervals_icu','strava')),
  -- Shapes differ by provider: intervals.icu is one API key, Strava is an
  -- OAuth triple that refreshes. jsonb rather than five nullable columns that
  -- are each meaningless for one of the two.
  secret      jsonb not null,
  external_id text,
  enabled     boolean not null default true,
  last_sync_at timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  primary key (user_id, provider)
);

comment on table integration_credentials is
  'Per-user sync credentials. Service role only: RLS is on and there are no '
  'policies, the push_config pattern. A missing row means that provider is not '
  'connected for that user, which is a supported state -- both, either, or '
  'neither may be configured and the app works in all four cases.';

alter table integration_credentials enable row level security;

-- The one definition of "activities that count", the sibling of v_live_sets.
-- Every endurance-derived view reads THIS, never `activities` directly, for the
-- same reason every set-derived view reads v_live_sets: a filter you have to
-- remember is one someone will forget.
create or replace view v_live_activities with (security_invoker = true) as
select a.*
from activities a
where a.discarded_at is null
  and a.duplicate_of is null;

comment on view v_live_activities is
  'Activities that count: discarded ones and cross-source duplicates excluded. '
  'Read this, never `activities`, in anything that measures training.';

-- Weekly endurance, bucketed in the OWNER's calendar rather than the
-- database's, passing the user_id of the row being bucketed the way every
-- other calendar view here does.
create or replace view v_weekly_endurance with (security_invoker = true) as
select
  user_id,
  (date_trunc('week', started_at at time zone app_tz(user_id)))::date as week_start,
  count(*)::int                as activities,
  sum(coalesce(moving_s, elapsed_s))::int as moving_s,
  sum(distance_m)              as distance_m,
  sum(ascent_m)                as ascent_m,
  sum(descent_m)               as descent_m,
  max(coalesce(moving_s, elapsed_s))::int as longest_moving_s,
  max(distance_m)              as longest_distance_m,
  -- Hours, not kilometres, is the honest unit for ultra work, and the reason
  -- both are here rather than one.
  count(*) filter (where sport in ('Run','TrailRun'))::int as runs
from v_live_activities
group by user_id, (date_trunc('week', started_at at time zone app_tz(user_id)))::date;

comment on view v_weekly_endurance is
  'Per user per ISO week in the owner''s timezone. Sums are NULL rather than 0 '
  'when no row carried the measurement, because a week with no descent data is '
  'not a flat week.';
