-- Keep a PWA edit to one planned day inside one Postgres transaction. The
-- client used to update the target row, its section mates, and each position
-- in separate PostgREST requests; a later failure left a plan whose rendered
-- sections and stored order described different workouts.
create or replace function public.apply_plan_edit(
  p_planned_workout_id uuid,
  p_target_id uuid,
  p_patch jsonb,
  p_section_ids uuid[],
  p_section text,
  p_apply_section boolean,
  p_ordered_ids uuid[]
) returns void
  language plpgsql
  set search_path = public
  as $$
declare
  v_uid uuid := auth.uid();
  v_patch public.prescriptions%rowtype;
  v_key text;
  v_count integer;
  v_park integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  -- A row lock serializes simultaneous edits to this day's plan. It does not
  -- claim to coordinate with sessions started on another device.
  perform 1
    from planned_workouts w
   where w.id = p_planned_workout_id
     and w.user_id = v_uid
     and w.discarded_at is null
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'planned workout not found';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'patch must be a JSON object';
  end if;
  if p_section_ids is null or p_ordered_ids is null then
    raise exception using errcode = '22023', message = 'section and order arrays are required';
  end if;
  if p_apply_section and (p_section is not null and length(trim(p_section)) = 0) then
    raise exception using errcode = '22023', message = 'section must be null or non-empty';
  end if;

  -- Keep the browser caller to prescription fields it already edits. In
  -- particular, identity, ownership, parent day, and position are not patchable.
  for v_key in select jsonb_object_keys(p_patch)
  loop
    if v_key not in (
      'sets', 'reps_min', 'reps_max', 'load_kg', 'load_pct_tm',
      'rest_seconds', 'superset_group', 'load_entry', 'entered_load',
      'entered_unit', 'tracking', 'set_type', 'notes'
    ) then
      raise exception using errcode = '22023', message = format('field %s cannot be edited here', v_key);
    end if;
  end loop;

  select count(*) into v_count
    from prescriptions p
   where p.planned_workout_id = p_planned_workout_id
     and p.user_id = v_uid;

  if cardinality(p_ordered_ids) <> v_count
     or (select count(distinct id) from unnest(p_ordered_ids) as ids(id)) <> v_count
     or exists (
       select 1
         from unnest(p_ordered_ids) as ids(id)
         left join prescriptions p
           on p.id = ids.id
          and p.planned_workout_id = p_planned_workout_id
          and p.user_id = v_uid
        where p.id is null
     ) then
    raise exception using errcode = '22023', message = 'order must contain every prescription in this day exactly once';
  end if;

  if exists (
    select 1
      from unnest(p_section_ids) as ids(id)
      left join prescriptions p
        on p.id = ids.id
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid
     where p.id is null
  ) or (select count(distinct id) from unnest(p_section_ids) as ids(id)) <> cardinality(p_section_ids) then
    raise exception using errcode = '22023', message = 'section rows must belong to this day exactly once';
  end if;

  if p_target_id is null then
    if p_patch <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'a patch requires a target prescription';
    end if;
  else
    select * into v_patch
      from prescriptions p
     where p.id = p_target_id
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid
     for update;
    if not found then
      raise exception using errcode = '42501', message = 'prescription not found';
    end if;

    v_patch := jsonb_populate_record(v_patch, p_patch);
    update prescriptions p set
      sets = case when p_patch ? 'sets' then v_patch.sets else p.sets end,
      reps_min = case when p_patch ? 'reps_min' then v_patch.reps_min else p.reps_min end,
      reps_max = case when p_patch ? 'reps_max' then v_patch.reps_max else p.reps_max end,
      load_kg = case when p_patch ? 'load_kg' then v_patch.load_kg else p.load_kg end,
      load_pct_tm = case when p_patch ? 'load_pct_tm' then v_patch.load_pct_tm else p.load_pct_tm end,
      rest_seconds = case when p_patch ? 'rest_seconds' then v_patch.rest_seconds else p.rest_seconds end,
      superset_group = case when p_patch ? 'superset_group' then v_patch.superset_group else p.superset_group end,
      load_entry = case when p_patch ? 'load_entry' then v_patch.load_entry else p.load_entry end,
      entered_load = case when p_patch ? 'entered_load' then v_patch.entered_load else p.entered_load end,
      entered_unit = case when p_patch ? 'entered_unit' then v_patch.entered_unit else p.entered_unit end,
      tracking = case when p_patch ? 'tracking' then v_patch.tracking else p.tracking end,
      set_type = case when p_patch ? 'set_type' then v_patch.set_type else p.set_type end,
      notes = case when p_patch ? 'notes' then v_patch.notes else p.notes end
    where p.id = p_target_id
      and p.planned_workout_id = p_planned_workout_id
      and p.user_id = v_uid;
  end if;

  if p_apply_section and cardinality(p_section_ids) > 0 then
    update prescriptions p
       set section = p_section
     where p.id = any(p_section_ids)
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid;
  end if;

  if v_count > 0 and exists (
    select 1
      from unnest(p_ordered_ids) with ordinality as wanted(id, ord)
      join prescriptions p on p.id = wanted.id
     where p.position <> wanted.ord - 1
  ) then
    select coalesce(max(position), -1) + v_count + 1 into v_park
      from prescriptions
     where planned_workout_id = p_planned_workout_id
       and user_id = v_uid;

    -- Positions are unique per day, so park the full ordered set before
    -- assigning its final contiguous positions. Both passes are one transaction.
    update prescriptions p
       set position = v_park + wanted.ord - 1
      from unnest(p_ordered_ids) with ordinality as wanted(id, ord)
     where p.id = wanted.id
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid;

    update prescriptions p
       set position = wanted.ord - 1
      from unnest(p_ordered_ids) with ordinality as wanted(id, ord)
     where p.id = wanted.id
       and p.planned_workout_id = p_planned_workout_id
       and p.user_id = v_uid;
  end if;
end
$$;

revoke all on function public.apply_plan_edit(uuid, uuid, jsonb, uuid[], text, boolean, uuid[]) from public, anon;
grant execute on function public.apply_plan_edit(uuid, uuid, jsonb, uuid[], text, boolean, uuid[]) to authenticated;
