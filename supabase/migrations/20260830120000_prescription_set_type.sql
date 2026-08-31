-- Warmups belong in the PLAN, not just in the log.
--
-- `sets.set_type` has existed since the first migration: the lifter marks a
-- set warmup or working as they log it. `prescriptions` had no equivalent, so
-- a coach's "2 warmup sets, then 3 working" could only be written down as a
-- ramp of consecutive rows with different loads and no way to say which of
-- them were warmups. The lifter then re-decided that on the gym floor, every
-- session, from memory.
--
-- The enum already exists and already carries the right three values. This is
-- one additive column with the safe default: every existing prescription is a
-- working set, which is what they all were.
alter table prescriptions
  add column set_type set_type not null default 'working';

comment on column prescriptions.set_type is
  'What this prescribed set-group IS. Warmup groups do not count toward the '
  'plan''s working-set target and are excluded from adherence via the ACTUAL '
  'set''s own set_type (see v_adherence).';

-- Expose it. Everything else in the view is unchanged from
-- 20260827160000_per_side_load.sql; the view is restated in full because
-- `create or replace view` cannot add a column in the middle of the list.
create or replace view v_resolved_prescriptions with (security_invoker = true) as
select
  p.id, p.user_id, p.planned_workout_id, p.exercise_id, e.name as exercise_name,
  p.position, p.sets, p.reps_min, p.reps_max, p.rest_seconds, p.notes,
  p.load_kg, p.load_pct_tm, tm.value_kg as tm_kg,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as resolved_load_kg,
  -- plate_load_kg rounds a TOTAL to the nearest 2.5 kg, which is the right
  -- granularity for a barbell and the wrong one for a per_side pair (dumbbells
  -- step 2.5 kg per hand = 5 kg total). Clients that show a per-side number
  -- must round the per-side value, not this one.
  round(coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) / 2.5) * 2.5 as plate_load_kg,
  p.superset_group,
  p.load_entry,
  p.set_type
from prescriptions p
join exercises e on e.id = p.exercise_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id;

-- v_adherence is deliberately NOT changed. It already gates on the ACTUAL
-- set's set_type (`where s.set_type in ('working','backoff')`), which is the
-- honest gate: what the lifter did is what counts, and a warmup they decided
-- to treat as a working set still counts as one. Filtering on the PLAN's
-- set_type here would let a mislabelled prescription silently delete real
-- work from the analysis.
