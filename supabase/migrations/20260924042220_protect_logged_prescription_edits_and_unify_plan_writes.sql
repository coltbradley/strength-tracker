-- The PWA's prescription edits and deletions now use one parent-first RPC.
-- This makes row ordering, a prescription patch, section membership, and a
-- removal one transaction under the same planned-day lock used by session
-- creation and MCP whole-day replacement.

-- A logged prescription is part of the training record even after its session
-- ends. It cannot be updated or removed, because sets are append-only and
-- adherence needs the prescription they fulfilled. Keep the existing SQLSTATE
-- so the PWA can translate this into actionable copy.
create or replace function public.refuse_orphaning_logged_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.sets s where s.prescription_id = old.id
  ) then
    raise exception using
      errcode = '23001',
      message = format('prescription %s has logged sets against it', old.id),
      hint = 'The prescription is part of training history and cannot be changed or removed.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger prescriptions_keep_logged_history on public.prescriptions;
create trigger prescriptions_keep_logged_history
  before update or delete on public.prescriptions
  for each row execute function public.refuse_orphaning_logged_sets();

-- A day that has any training history is immutable at the prescription level.
-- This includes adding a new row or touching an otherwise unlogged row, so a
-- direct PWA insert and an MCP whole-day replacement share the same rule.
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

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

-- Keep the normal PWA path inside the same transaction for both row edits and
-- deletions. A deletion derives the survivors' order under the parent lock,
-- avoiding a stale client-side list if an add races with the removal.
create or replace function public.apply_plan_edit_with_delete(
  p_planned_workout_id uuid,
  p_target_id uuid,
  p_patch jsonb,
  p_section_ids uuid[],
  p_section text,
  p_apply_section boolean,
  p_ordered_ids uuid[],
  p_delete_id uuid
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ordered_ids uuid[];
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  perform 1
    from public.planned_workouts w
   where w.id = p_planned_workout_id
     and w.user_id = v_uid
     and w.discarded_at is null
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  if p_delete_id is not null then
    if p_target_id is not null or p_patch is distinct from '{}'::jsonb
       or cardinality(coalesce(p_section_ids, array[]::uuid[])) > 0
       or p_apply_section then
      raise exception using errcode = '22023', message = 'a delete cannot include another prescription edit';
    end if;

    delete from public.prescriptions p
     where p.id = p_delete_id
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid;
    if not found then
      raise exception using errcode = '42501', message = 'prescription not found';
    end if;

    select coalesce(array_agg(p.id order by p.position), array[]::uuid[])
      into v_ordered_ids
      from public.prescriptions p
     where p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid;
  else
    v_ordered_ids := p_ordered_ids;
  end if;

  perform public.apply_plan_edit(
    p_planned_workout_id,
    p_target_id,
    p_patch,
    p_section_ids,
    p_section,
    p_apply_section,
    v_ordered_ids
  );
end
$$;

revoke all on function public.apply_plan_edit_with_delete(uuid, uuid, jsonb, uuid[], text, boolean, uuid[], uuid) from public, anon;
grant execute on function public.apply_plan_edit_with_delete(uuid, uuid, jsonb, uuid[], text, boolean, uuid[], uuid) to authenticated;
