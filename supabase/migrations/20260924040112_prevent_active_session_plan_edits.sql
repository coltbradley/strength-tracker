-- Serialize every prescription write through its parent day and refuse plan
-- changes while any device has an unfinished session against that day.
-- Session creation takes the same lock, so a plan edit and a new workout start
-- have a well-defined order even when they come from different devices.

create or replace function public.lock_planned_workout_for_session()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if new.planned_workout_id is null then
    return new;
  end if;

  select w.user_id into v_owner
    from public.planned_workouts w
   where w.id = new.planned_workout_id
   for update;

  if not found or v_owner <> new.user_id then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;
  return new;
end
$$;

create trigger sessions_lock_planned_workout_insert
  before insert on public.sessions
  for each row execute function public.lock_planned_workout_for_session();

create trigger sessions_lock_planned_workout_retarget
  before update of planned_workout_id on public.sessions
  for each row execute function public.lock_planned_workout_for_session();

create or replace function public.guard_planned_workout_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.sessions s
     where s.user_id = old.user_id
       and s.planned_workout_id = old.id
       and s.ended_at is null
       and s.discarded_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'cannot change a planned workout while it has an open session',
      hint = 'Finish or discard the active session before changing the planned workout.';
  end if;
  return new;
end
$$;

create trigger planned_workouts_guard_open_session
  before update of day_index, scheduled_date, label, notes, discarded_at
  on public.planned_workouts
  for each row execute function public.guard_planned_workout_update();

create or replace function public.guard_prescription_plan_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day uuid;
  v_owner uuid;
  v_row_owner uuid;
begin
  if tg_op = 'DELETE' then
    v_day := old.planned_workout_id;
    v_row_owner := old.user_id;
  else
    v_day := new.planned_workout_id;
    v_row_owner := new.user_id;
  end if;

  if tg_op = 'UPDATE' and old.planned_workout_id <> new.planned_workout_id then
    raise exception using errcode = '22023', message = 'a prescription cannot move between planned workouts';
  end if;

  select w.user_id into v_owner
    from public.planned_workouts w
   where w.id = v_day
   for update;

  if not found and tg_op = 'DELETE' then
    -- Hard deletion is allowed only for templates. Their FK cascade reaches
    -- this trigger after the parent row has left the table; the logged-set
    -- guard still runs on every child before that cascade lands.
    return old;
  end if;
  if not found or v_owner <> v_row_owner then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  if exists (
    select 1
      from public.sessions s
     where s.user_id = v_owner
       and s.planned_workout_id = v_day
       and s.ended_at is null
       and s.discarded_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'cannot change prescriptions while this planned workout has an open session',
      hint = 'Finish or discard the active session before changing the planned workout.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger prescriptions_serialize_plan_writes
  before insert or update or delete on public.prescriptions
  for each row execute function public.guard_prescription_plan_write();

create or replace function public.swap_planned_workout_order(
  p_first_id uuid,
  p_second_id uuid
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_program uuid;
  v_first_index integer;
  v_second_index integer;
  v_first_date date;
  v_second_date date;
  v_temporary_index integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_first_id = p_second_id then
    return;
  end if;

  -- Lock both days in stable id order so two simultaneous swaps cannot
  -- deadlock by acquiring the same pair in opposite order.
  perform 1
    from public.planned_workouts w
   where w.id in (p_first_id, p_second_id)
     and w.user_id = v_uid
     and w.discarded_at is null
   order by w.id
   for update;
  if (select count(*) from public.planned_workouts w
       where w.id in (p_first_id, p_second_id)
         and w.user_id = v_uid and w.discarded_at is null) <> 2 then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  select program_id, day_index, scheduled_date
    into v_program, v_first_index, v_first_date
    from public.planned_workouts where id = p_first_id and user_id = v_uid;
  select day_index, scheduled_date
    into v_second_index, v_second_date
    from public.planned_workouts where id = p_second_id and user_id = v_uid;
  if exists (select 1 from public.planned_workouts
              where id = p_second_id and program_id <> v_program) then
    raise exception using errcode = '22023', message = 'planned workouts must belong to the same program';
  end if;
  if exists (
    select 1 from public.sessions s
     where s.user_id = v_uid
       and s.planned_workout_id in (p_first_id, p_second_id)
       and s.ended_at is null and s.discarded_at is null
  ) then
    raise exception using errcode = '55000', message = 'cannot reorder a planned workout while it has an open session';
  end if;

  select coalesce(max(day_index), -1) + 1 into v_temporary_index
    from public.planned_workouts where program_id = v_program;
  update public.planned_workouts set day_index = v_temporary_index where id = p_first_id;
  update public.planned_workouts
     set day_index = v_first_index, scheduled_date = v_first_date
   where id = p_second_id;
  update public.planned_workouts
     set day_index = v_second_index, scheduled_date = v_second_date
   where id = p_first_id;
end
$$;

revoke all on function public.swap_planned_workout_order(uuid, uuid) from public, anon;
grant execute on function public.swap_planned_workout_order(uuid, uuid) to authenticated;

-- MCP replaces an entire day's prescription list. Keep its delete and insert
-- together in one transaction under the same parent-row lock used by the PWA.
-- This also keeps the service-role caller scoped to the token's owner id.
create or replace function public.replace_planned_workout_prescriptions(
  p_user_id uuid,
  p_planned_workout_id uuid,
  p_rows jsonb,
  p_workout_patch jsonb default '{}'::jsonb
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_key text;
  v_owner uuid;
begin
  if current_user <> 'service_role' then
    v_uid := auth.uid();
    if v_uid is distinct from p_user_id then
      raise exception using errcode = '42501', message = 'not authorized for this planned workout';
    end if;
  end if;

  select w.user_id into v_owner
    from public.planned_workouts w
   where w.id = p_planned_workout_id
     and w.user_id = p_user_id
     and w.discarded_at is null
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  if p_workout_patch is null or jsonb_typeof(p_workout_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'workout patch must be a JSON object';
  end if;
  for v_key in select jsonb_object_keys(p_workout_patch)
  loop
    if v_key not in ('label', 'notes', 'scheduled_date') then
      raise exception using errcode = '22023', message = format('field %s cannot be edited here', v_key);
    end if;
  end loop;

  if p_rows is not null and jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'prescriptions must be a JSON array';
  end if;

  if p_rows is not null then
    delete from public.prescriptions
     where user_id = p_user_id
       and planned_workout_id = p_planned_workout_id;

    insert into public.prescriptions (
      user_id, planned_workout_id, exercise_id, position, sets,
      reps_min, reps_max, load_kg, load_pct_tm, rest_seconds, notes,
      set_type, superset_group, section, tracking, load_entry,
      entered_load, entered_unit
    )
    select p_user_id, p_planned_workout_id, x.exercise_id, x.position, x.sets,
           x.reps_min, x.reps_max, x.load_kg, x.load_pct_tm, x.rest_seconds,
           x.notes, x.set_type, x.superset_group, x.section, x.tracking,
           x.load_entry, x.entered_load, x.entered_unit
      from jsonb_to_recordset(p_rows) as x(
        exercise_id text,
        position integer,
        sets integer,
        reps_min integer,
        reps_max integer,
        load_kg numeric,
        load_pct_tm numeric,
        rest_seconds integer,
        notes text,
        set_type public.set_type,
        superset_group smallint,
        section text,
        tracking public.tracking_mode,
        load_entry public.load_entry_mode,
        entered_load numeric,
        entered_unit public.load_unit
      );
  end if;

  if p_workout_patch ? 'label' or p_workout_patch ? 'notes' or p_workout_patch ? 'scheduled_date' then
    update public.planned_workouts set
      label = case when p_workout_patch ? 'label' then p_workout_patch ->> 'label' else label end,
      notes = case when p_workout_patch ? 'notes' then p_workout_patch ->> 'notes' else notes end,
      scheduled_date = case when p_workout_patch ? 'scheduled_date'
        then (p_workout_patch ->> 'scheduled_date')::date else scheduled_date end
     where id = p_planned_workout_id
       and user_id = p_user_id;
  end if;
end
$$;

revoke all on function public.replace_planned_workout_prescriptions(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_planned_workout_prescriptions(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
