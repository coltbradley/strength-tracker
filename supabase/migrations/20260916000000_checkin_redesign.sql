-- Check-in redesign. Spec: docs/superpowers/specs/2026-09-16-checkin-redesign-design.md
--
-- A check-in becomes the one subjective capture: timestamped, unlimited per
-- day, three optional inputs (note, tags, energy). The once-a-day readiness
-- panel was never used and is removed rather than hidden.

-- 1. CHECK-INS LEARN TAGS, AND A PAIN CHECK-IN FILES AGAINST AN EPISODE ------
--
-- Tags are a column, not words appended into the note, so they can be counted.
-- The vocabulary is closed here because this CHECK is what decides what a tag
-- may be; the PWA's list only decides what is worth a tap.
alter table checkins
  add column tags text[] not null default '{}'
    constraint checkins_tags_vocab check (
      tags <@ array['great','slept_badly','unusually_sore','stressed','sick','pain']::text[]
    ),
  add column episode_id uuid references symptom_episodes (id) on delete set null,
  add column training_impact text
    constraint checkins_training_impact check (
      training_impact in ('none','modified','stopped')
    );

-- An injury link or a training answer only means something on a pain check-in.
alter table checkins add constraint checkins_pain_fields
  check ((episode_id is null and training_impact is null) or 'pain' = any (tags));

create index idx_checkins_episode on checkins (episode_id) where episode_id is not null;

comment on table checkins is
  'Unlimited per day, every row its own timestamped event; nothing overwrites. '
  'Read by time of day (v_checkins_local, v_checkin_buckets): energy has a daily '
  'rhythm, so a reading is only compared with the same bucket, and no mean is '
  'ever taken across buckets or into a daily score. The post_session row is '
  'where session-RPE timing lives when used.';

-- 2. VIEWS ------------------------------------------------------------------
--
-- Buckets are fixed clock times, not personalised: a personal split needs weeks
-- of data nobody has on day one. The row's OWN user's timezone, so the PWA and
-- the service-role MCP path give the same answer.
create or replace view v_checkins_local with (security_invoker = true) as
select
  c.id, c.user_id, c.kind, c.recorded_at, c.note, c.energy, c.feeling, c.tags,
  c.training_impact, c.episode_id, c.session_id, c.activity_id,
  (c.recorded_at at time zone app_tz(c.user_id))::date as local_date,
  case
    when extract(hour from c.recorded_at at time zone app_tz(c.user_id)) < 11 then 'morning'
    when extract(hour from c.recorded_at at time zone app_tz(c.user_id)) < 16 then 'midday'
    else 'evening'
  end as bucket
from checkins c;

-- Every mean carries its own count, because avg() skips nulls and a bucket of
-- three check-ins with one energy score is not a bucket of three scores.
create or replace view v_checkin_buckets with (security_invoker = true) as
select
  l.user_id,
  l.local_date,
  l.bucket,
  count(*)::int as checkins,
  count(l.energy)::int as energy_n,
  round(avg(l.energy), 2) as energy_mean,
  min(l.energy)::int as energy_min,
  max(l.energy)::int as energy_max,
  coalesce(
    (select array_agg(distinct t order by t)
       from v_checkins_local l2, unnest(l2.tags) as t
      where l2.user_id = l.user_id
        and l2.local_date = l.local_date
        and l2.bucket = l.bucket),
    '{}'::text[]
  ) as tags
from v_checkins_local l
group by l.user_id, l.local_date, l.bucket;

-- An episode's life as check-ins describe it. `quiet` is a LABEL, never a
-- write to closed_on: not mentioning a knee and not checking in at all look
-- the same, so silence is not recovery. Only the lifter closes an episode.
create or replace view v_injury_state with (security_invoker = true) as
select
  e.id as episode_id,
  e.user_id,
  e.body_region,
  e.side,
  e.opened_on,
  e.closed_on,
  r.first_reported_at,
  r.last_reported_at,
  (r.last_reported_at at time zone app_tz(e.user_id))::date as last_reported_on,
  r.reports,
  r.impact_none,
  r.impact_modified,
  r.impact_stopped,
  case
    when e.closed_on is not null then 'closed'
    when coalesce(r.last_reported_at, e.opened_on::timestamptz) < now() - interval '14 days'
      then 'quiet'
    else 'active'
  end as state
from symptom_episodes e
cross join lateral (
  select
    min(c.recorded_at) as first_reported_at,
    max(c.recorded_at) as last_reported_at,
    count(*)::int as reports,
    (count(*) filter (where c.training_impact = 'none'))::int as impact_none,
    (count(*) filter (where c.training_impact = 'modified'))::int as impact_modified,
    (count(*) filter (where c.training_impact = 'stopped'))::int as impact_stopped
  from checkins c
  where c.episode_id = e.id
) r;

-- 3. THE MORNING PANEL GOES ------------------------------------------------
--
-- Production held one daily_readiness row and no readiness_fields when this
-- was written. It is dropped with the table.
drop view if exists v_readiness_trend;
drop table if exists readiness_fields;
drop table if exists daily_readiness;

delete from rest_alerts where kind = 'daily_readiness';
alter table rest_alerts drop constraint if exists rest_alerts_kind_check;
alter table rest_alerts add constraint rest_alerts_kind_check
  check (kind in ('rest','ostrc_weekly','next_morning_pain'));
