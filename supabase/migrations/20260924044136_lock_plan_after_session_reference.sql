-- A session can finish on one device while its sets are still waiting in that
-- device's outbox. Keep the prescription rows stable until the session is
-- explicitly discarded, even when no set has reached Postgres yet.

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
       and s.discarded_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'cannot change the plan because a session references this planned workout',
      hint = 'Keep the planned day intact so any queued sets can sync against it, or edit a future day.';
  end if;
  return new;
end
$$;

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
    -- Hard deletion is still only allowed for a template. Keep the separate
    -- row history trigger active for a cascade whose parent has disappeared.
    return old;
  end if;
  if not found or v_owner <> v_row_owner then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  if exists (
    select 1
      from public.prescriptions p
      join public.sets s on s.prescription_id = p.id
     where p.planned_workout_id = v_day
  ) then
    raise exception using errcode = '23001',
      message = format('planned workout %s has logged sets against its prescriptions', v_day),
      hint = 'The planned day is part of training history and its prescriptions cannot be changed.';
  end if;

  if exists (
    select 1
      from public.sessions s
     where s.user_id = v_owner
       and s.planned_workout_id = v_day
       and s.discarded_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'cannot change the plan because a session references this planned workout',
      hint = 'Keep the planned day intact so any queued sets can sync against it, or edit a future day.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

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
       and s.discarded_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'cannot reorder the plan because a session references one of these planned workouts',
      hint = 'Keep the planned days in place so any queued sets can sync against them, or edit future days.';
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
