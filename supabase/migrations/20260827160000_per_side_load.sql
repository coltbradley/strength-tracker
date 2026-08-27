-- Per-side (unilateral) load convention (additive; see docs/decisions.md
-- 2026-08-27 "per-side load: load_kg is always the total system load").
--
-- THE RULE: `load_kg` is ALWAYS the TOTAL SYSTEM LOAD — the whole weight
-- moved in one rep. A pair of 30 kg dumbbells is 60. No view, query, chart or
-- MCP tool ever has to ask "per hand or total?" before it can sum, compare or
-- estimate, so every derived view keeps working untouched and keeps being
-- right. The alternative (store the typed number, make readers multiply)
-- pushes the ambiguity into every present and future reader, including
-- Claude's.
--
-- `load_entry` records how the number was EXPRESSED, so the app can display
-- and prefill "30 x 2" faithfully and Claude can report honest numbers:
--
--   'total'     the value is the whole system: a barbell, a machine stack, or
--               one implement moved on its own — INCLUDING single-arm work,
--               where one 30 kg dumbbell really is the whole system for that
--               rep.
--   'per_side'  the value is ONE side and both sides move together (a pair of
--               dumbbells, a trap bar handle per hand). load_kg = 2 x typed.
--   NULL        not asserted: logged before this convention existed, or by a
--               client that does not set it.
--
-- NULL is deliberately NOT the same as 'total'. `sets` is append-only and RLS
-- has no update path, so pre-convention rows can never be corrected — their
-- ambiguity is permanent and must stay visible. Readers must treat NULL as
-- "unknown", never as "confirmed total". A default of 'total' would have
-- silently backdated an assertion nobody made.
--
-- Deliberately NOT modelled: alternating one-limb-at-a-time work is 'total'
-- (the load is honest; it is the REPS that are per side). Reps-per-side stays
-- out of the schema — log each side as its own set.

create type load_entry_mode as enum ('total', 'per_side');

-- ACTUAL ---------------------------------------------------------------------

alter table sets add column load_entry load_entry_mode;

-- 'per_side' is meaningless on a bodyweight set (load_kg = 0 means
-- bodyweight); half of nothing is still nothing. Existing rows all have
-- load_entry NULL, so the constraint validates instantly.
alter table sets add constraint sets_per_side_needs_load
  check (load_entry is distinct from 'per_side'::load_entry_mode or load_kg > 0);

-- PLANNED --------------------------------------------------------------------
-- The plan side carries the same convention, for the same reason: a coach's
-- "DB row 3x10 @ 30" is per hand. Without this, prescriptions would store the
-- per-hand number while sets store the total, and v_adherence would report a
-- phantom +30 kg overshoot on every dumbbell set it ever compared.
-- Resolved %TM loads are totals too (training maxes are whole-system values);
-- load_entry then describes only how to express that total to the lifter.

alter table prescriptions add column load_entry load_entry_mode;

alter table prescriptions add constraint rx_per_side_needs_load
  check (
    load_entry is distinct from 'per_side'::load_entry_mode
    or load_kg is not null
    or load_pct_tm is not null
  );

-- Views ----------------------------------------------------------------------
-- All three are `create or replace` with columns APPENDED only, so dependent
-- views (v_e1rm, v_weekly_volume, v_session_set_counts, v_rest,
-- v_session_best_e1rm, v_goal_progress) follow automatically and none of the
-- load math changes — load_kg was already the total.

-- v_live_sets is `select s.*`, which Postgres expanded at creation time, so it
-- does not pick up a new `sets` column on its own. Replace it (same column
-- list, load_entry appended by the alter above).
create or replace view v_live_sets with (security_invoker = true) as
select s.*
from sets s
join sessions ss on ss.id = s.session_id
where ss.discarded_at is null
  and not exists (
    select 1 from set_voids v
    where v.set_id = s.id and v.user_id = s.user_id
  );

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
  p.load_entry
from prescriptions p
join exercises e on e.id = p.exercise_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id;

-- Adherence compares totals to totals and is unchanged by the convention.
-- Both entry modes are exposed so a reader can render the comparison in the
-- units the lifter actually used instead of quoting a doubled number back.
create or replace view v_adherence with (security_invoker = true) as
select
  s.id as set_id, s.user_id, s.session_id, s.exercise_id,
  s.prescription_id, s.set_index, s.performed_at,
  s.load_kg as actual_load_kg, s.reps as actual_reps,
  p.reps_min, p.reps_max,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as prescribed_load_kg,
  s.load_kg - coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as load_delta_kg,
  case
    when s.reps < p.reps_min then 'missed'
    when s.reps > p.reps_max then 'exceeded'
    else 'hit'
  end as rep_outcome,
  s.load_entry as actual_load_entry,
  p.load_entry as prescribed_load_entry
from v_live_sets s
join prescriptions p on p.id = s.prescription_id
left join lateral (
  select t.value_kg
  from training_maxes t
  where t.user_id = s.user_id
    and t.exercise_id = s.exercise_id
    and t.effective_date <= (s.performed_at at time zone app_tz())::date
  order by t.effective_date desc
  limit 1
) tm on true
where s.set_type in ('working', 'backoff');

-- No hint column on `exercises` on purpose. It is a shared library seeded from
-- two sources (see CLAUDE.md): free-exercise-db carries no unilateral field,
-- so 873 generated rows could never be populated and each re-seed would write
-- the column back to null. The UI derives its DEFAULT from `equipment` and the
-- movement name (equipment = 'dumbbell' and not single/one-arm/alternating ->
-- per_side) and persists any override in the device-local per-exercise
-- settings, which is where per-user preference already lives. The default only
-- has to be right often enough to save a tap; load_entry on the row is what
-- makes the record honest.
