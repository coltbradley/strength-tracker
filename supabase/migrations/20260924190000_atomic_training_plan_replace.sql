-- A-84: replacing a training plan in one transaction.
--
-- set_training_plan used to supersede the live plan, insert the new one and
-- insert its phases as separate PostgREST requests, then try to undo the
-- supersede if a later step failed. PostgREST has no transactions, so a
-- failure between steps, a failed compensation, or two calls racing could
-- leave the lifter with no live plan at all. This function is that whole
-- sequence as one statement's transaction: it lands complete or not at all.
--
-- Callers: the MCP server only, as the service role (which bypasses RLS), so
-- every row is stamped with p_user_id here rather than trusting a default.
-- The PWA never writes plans; authenticated sessions cannot execute this.

create or replace function public.replace_training_plan(
  p_user_id uuid,
  p_objective text,
  p_starts_on date,
  p_ends_on date,
  p_source_note text,
  p_phases jsonb,
  p_confirm_change boolean default false
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev public.training_plans%rowtype;
  v_plan_id uuid;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user id is required';
  end if;
  if p_phases is null
     or jsonb_typeof(p_phases) <> 'array'
     or jsonb_array_length(p_phases) = 0 then
    raise exception using errcode = '22023', message = 'a plan needs at least one phase';
  end if;

  -- Two calls for one person run one after the other. Without this, the
  -- second would wait on the row lock below, find no live plan once the
  -- first committed, and fail on the one-live-plan index instead of
  -- superseding the plan the first call wrote.
  perform pg_advisory_xact_lock(hashtextextended('training_plan:' || p_user_id::text, 0));

  select * into v_prev
    from public.training_plans
   where user_id = p_user_id
     and superseded_at is null
   for update;

  if found then
    -- The gate lives here as well as in the tool, because the plan read in
    -- the tool can have been confirmed by the time this runs.
    if v_prev.confirmed_at is not null and not coalesce(p_confirm_change, false) then
      raise exception using
        errcode = 'P0001',
        message = format(
          'plan %s is confirmed; replacing it needs confirm_change=true after the user approves the new plan in chat',
          v_prev.id);
    end if;
    update public.training_plans
       set superseded_at = now()
     where id = v_prev.id;
  end if;

  insert into public.training_plans
    (user_id, objective, starts_on, ends_on, source_note, confirmed_at)
  values
    (p_user_id, p_objective, p_starts_on, p_ends_on, p_source_note, null)
  returning id into v_plan_id;

  -- One statement, so the AFTER ROW overlap trigger sees every phase.
  insert into public.plan_phases
    (user_id, plan_id, position, name, starts_on, ends_on, focus, progression,
     sessions_per_week, primary_exercise_ids, notes)
  select p_user_id, v_plan_id, (e.ord - 1)::int, ph.name, ph.starts_on,
         ph.ends_on, ph.focus, ph.progression, ph.sessions_per_week,
         coalesce(ph.primary_exercise_ids, '{}'), ph.notes
    from jsonb_array_elements(p_phases) with ordinality as e(value, ord)
   cross join lateral jsonb_to_record(e.value) as ph(
     name text,
     starts_on date,
     ends_on date,
     focus text,
     progression text,
     sessions_per_week int,
     primary_exercise_ids text[],
     notes text);

  return jsonb_build_object(
    'plan_id', v_plan_id,
    'superseded_plan_id', v_prev.id,
    'superseded_plan_was_confirmed', v_prev.confirmed_at is not null);
end
$$;

revoke all on function public.replace_training_plan(uuid, text, date, date, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.replace_training_plan(uuid, text, date, date, text, jsonb, boolean)
  to service_role;
