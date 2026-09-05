-- Time-tracked work: planks, carries, dead hangs, bike sprints.
--
-- Today these are prescribed as `tracking = 'done'` and collapse to a tick, so
-- a 90 second plank and a 20 second one are the same record. The coach cannot
-- see progression on any of it.
--
-- The roadmap proposed storing the seconds in `reps`, on the reasoning that a
-- second numeric column would make every view branch. That turns out to be
-- backwards on both halves.
--
-- It does not fit: `reps` is checked `between 0 and 100`, so a three minute
-- carry is not representable at all, and widening that check would weaken a
-- real guard on ordinary sets to make room for a value that is not reps.
--
-- And it is not free: a 45 second farmer's carry at 64 kg would land in
-- v_e1rm's `reps between 1 and 8` window as soon as it was short enough, and
-- in v_weekly_volume's tonnage as 64 x 45. Seconds would be silently priced as
-- repetitions.
--
-- A separate nullable column makes NOTHING branch instead. A time set writes
-- reps 0, exactly as a 'done' tick does, so every existing filter excludes it
-- through the predicate it already has, and the duration rides alongside where
-- only a reader that asks for it can see it.

alter type tracking_mode add value 'time';

comment on column prescriptions.tracking is
  'reps = load and reps, the default and what every view analyses. done = a '
  'completion tick. time = hold or carry for a duration, written as a real set '
  'with reps 0 and the seconds in sets.duration_seconds. All three are one '
  'record in `sets`; done and time are excluded from volume and e1RM by those '
  'views'' existing working-set and rep-range filters, with no filter on '
  'tracking anywhere, because the analysis must not depend on the plan.';

alter table sets
  add column duration_seconds int
  -- Two hours. Long enough for anything anyone holds or carries, short enough
  -- that a millisecond value typed in by mistake is refused rather than
  -- charted.
  check (duration_seconds is null or duration_seconds between 1 and 7200);

comment on column sets.duration_seconds is
  'How long the effort lasted, for work measured in time rather than reps. '
  'Null on every ordinary set. A time set carries reps 0 so that volume and '
  'e1RM ignore it exactly as they ignore a completion tick, and load_kg still '
  'means the total system load, so a weighted carry records both what was '
  'carried and for how long.';

-- Same reason as every other column addition: v_live_sets is `select s.*`,
-- expanded once at creation, and only a replace picks up a new column.
create or replace view v_live_sets with (security_invoker = true) as
select s.*
from sets s
join sessions ss on ss.id = s.session_id
where ss.discarded_at is null
  and not exists (
    select 1 from set_voids v
    where v.set_id = s.id and v.user_id = s.user_id
  );
