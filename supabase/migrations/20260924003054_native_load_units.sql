-- Preserve the number and unit authored for a load while keeping load_kg as
-- the canonical total-system value used by every analytical view.
create type load_unit as enum ('kg', 'lb');

alter table sets
  add column entered_load numeric(9,3),
  add column entered_unit load_unit;

alter table prescriptions
  add column entered_load numeric(9,3),
  add column entered_unit load_unit;

alter table sets add constraint sets_entered_load_pair
  check ((entered_load is null) = (entered_unit is null));
alter table prescriptions add constraint rx_entered_load_pair
  check ((entered_load is null) = (entered_unit is null));

alter table sets add constraint sets_entered_load_positive
  check (entered_load is null or (entered_load > 0 and entered_load <= 999999.999));
alter table prescriptions add constraint rx_entered_load_positive
  check (entered_load is null or (entered_load > 0 and entered_load <= 999999.999));

comment on column sets.entered_load is
  'The exact direct-load number authored in entered_unit and expressed by load_entry. Null marks a legacy row.';
comment on column sets.entered_unit is
  'The authored unit for entered_load. Null marks a legacy row; never infer kg.';
comment on column prescriptions.entered_load is
  'The exact direct-load number authored in entered_unit and expressed by load_entry. Null marks a legacy or %TM prescription.';
comment on column prescriptions.entered_unit is
  'The authored unit for entered_load. Null marks a legacy or %TM prescription; never infer kg.';

create or replace function validate_entered_load_consistency() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  declare
    row_data jsonb := to_jsonb(new);
    value_text text := row_data ->> 'entered_load';
    unit_text text := row_data ->> 'entered_unit';
    entry_text text := row_data ->> 'load_entry';
    stored_text text := row_data ->> 'load_kg';
    pct_text text := row_data ->> 'load_pct_tm';
    expected_total numeric;
  begin
    -- Null provenance is kept for legacy rows and old offline queue payloads.
    -- New PWA/MCP writers always provide both fields for direct loads.
    if value_text is null and unit_text is null then
      return new;
    end if;
    if value_text is null or unit_text is null then
      raise exception using errcode = 'check_violation',
        message = 'entered_load and entered_unit must be supplied together';
    end if;
    if entry_text is null then
      raise exception using errcode = 'check_violation',
        message = 'authored loads require load_entry';
    end if;
    if pct_text is not null then
      raise exception using errcode = 'check_violation',
        message = 'percentage prescriptions cannot carry an authored direct load';
    end if;

    expected_total := round(
      (value_text::numeric * case unit_text when 'lb' then 0.45359237 else 1 end) *
      case entry_text when 'per_side' then 2 else 1 end,
      2
    );
    if stored_text is null or expected_total <> stored_text::numeric then
      raise exception using errcode = 'check_violation',
        message = 'load_kg must match entered_load, entered_unit, and load_entry';
    end if;
    return new;
  end
  $$;

create trigger sets_validate_entered_load
  before insert or update on sets
  for each row execute function validate_entered_load_consistency();
create trigger prescriptions_validate_entered_load
  before insert or update on prescriptions
  for each row execute function validate_entered_load_consistency();

-- select s.* was expanded when the view was first created; recreate it after
-- adding table columns so the two provenance fields reach every live-set read.
create or replace view v_live_sets with (security_invoker = true) as
select s.*
from sets s
join sessions ss on ss.id = s.session_id
where ss.discarded_at is null
  and not exists (
    select 1 from set_voids v
    where v.set_id = s.id and v.user_id = s.user_id
  );

-- Append authored fields after the established API surface so dependent
-- clients keep their column order and old projections retain their meaning.
create or replace view v_resolved_prescriptions with (security_invoker = true) as
select
  p.id, p.user_id, p.planned_workout_id, p.exercise_id, e.name as exercise_name,
  p.position, p.sets, p.reps_min, p.reps_max, p.rest_seconds, p.notes,
  p.load_kg, p.load_pct_tm, tm.value_kg as tm_kg,
  coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) as resolved_load_kg,
  round(coalesce(p.load_kg, round(p.load_pct_tm / 100.0 * tm.value_kg, 1)) / 2.5) * 2.5 as plate_load_kg,
  p.superset_group,
  p.load_entry,
  p.set_type,
  p.section,
  p.tracking,
  p.entered_load,
  p.entered_unit
from prescriptions p
join exercises e on e.id = p.exercise_id
join planned_workouts w on w.id = p.planned_workout_id
join programs pr on pr.id = w.program_id
left join v_current_tm tm
  on tm.user_id = p.user_id and tm.exercise_id = p.exercise_id
where w.discarded_at is null
  and pr.discarded_at is null;

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
  p.load_entry as prescribed_load_entry,
  s.entered_load as actual_entered_load,
  s.entered_unit as actual_entered_unit,
  p.entered_load as prescribed_entered_load,
  p.entered_unit as prescribed_entered_unit
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
