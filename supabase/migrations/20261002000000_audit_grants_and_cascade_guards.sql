-- Audit 2026-10-01, stream A: function grants (DB-3, DB-4) and two history
-- triggers that mis-fired for the people they were written to protect
-- (DB-1, DB-2).

-- DB-3: the vault key was callable by the public anon key. `revoke ... from
-- public` (20260921030000) does not remove the explicit EXECUTE grants that
-- Supabase's default privileges give anon and authenticated at CREATE time;
-- 20260905030000 already documents this trap. Only the endurance-sync edge
-- function (service_role) calls encrypt/decrypt, and those two are SECURITY
-- DEFINER, so they reach integration_encryption_key() as the owner and do not
-- need it granted to anyone.
revoke all on function public.integration_encryption_key() from public, anon, authenticated;
revoke all on function public.encrypt_integration_secret(jsonb) from public, anon, authenticated;
revoke all on function public.decrypt_integration_secret(bytea) from public, anon, authenticated;
revoke all on function public._integration_xor_obfuscate(bytea, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.encrypt_integration_secret(jsonb) to service_role;
    grant execute on function public.decrypt_integration_secret(bytea) to service_role;
  end if;
end
$$;

-- DB-4: reserve_coach_turn took any user id and any limits from anon. It is
-- the coach edge function's (service_role) alone. Recreated only to add
-- pg_temp to the pinned search_path; the body is unchanged.
create or replace function public.reserve_coach_turn(
  p_user_id uuid,
  p_turn_id uuid,
  p_day_limit int,
  p_month_token_limit numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_n int;
  month_spent numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::int into day_n
  from coach_usage
  where user_id = p_user_id
    and kind = 'turn'
    and refused is null
    and created_at >= now() - interval '1 day';

  if day_n >= p_day_limit then
    return jsonb_build_object(
      'ok', false,
      'reason', 'Daily limit reached (' || p_day_limit ||
        ' messages). It resets a day after your first message today.'
    );
  end if;

  select coalesce(sum(output_tokens + input_tokens / 5.0), 0) into month_spent
  from coach_usage
  where user_id = p_user_id
    and created_at >= now() - interval '30 days';

  if month_spent >= p_month_token_limit then
    return jsonb_build_object(
      'ok', false,
      'reason', 'Monthly limit reached for the coach. Tell Colt if you need it raised.'
    );
  end if;

  begin
    insert into coach_usage (
      user_id, turn_id, model, kind, input_tokens, output_tokens
    ) values (
      p_user_id, p_turn_id, 'reserved', 'turn', 0, 0
    );
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_turn');
  end;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.reserve_coach_turn(uuid, uuid, int, numeric) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.reserve_coach_turn(uuid, uuid, int, numeric) to service_role;
  end if;
end
$$;

-- DB-2: refuse_rewriting_used_training_max asks "is the person being deleted?"
-- by reading auth.users, which `authenticated` cannot select, so every
-- same-day correction and every delete of a training max from the PWA failed
-- with "permission denied for table users". SECURITY DEFINER lets the check
-- read it. The body is otherwise unchanged: an ordinary edit of a max that
-- logged sets depended on is still refused. The function only ever looks at
-- rows scoped by old.user_id, so running as the owner reveals nothing the
-- caller could not already see. Trigger functions are not rpc-callable, but
-- the grant is removed anyway so the definer-function audit in validate-db
-- stays a plain "nothing is executable".
create or replace function public.refuse_rewriting_used_training_max()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next date;
begin
  if tg_op = 'UPDATE'
     and new.user_id is not distinct from old.user_id
     and new.exercise_id is not distinct from old.exercise_id
     and new.value_kg is not distinct from old.value_kg
     and new.effective_date is not distinct from old.effective_date then
    return new;
  end if;

  -- Deleting the person takes their history with it; nothing is rewritten
  -- that anyone can still read.
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    return coalesce(new, old);
  end if;

  -- The day the next max for this lift takes over, which ends OLD's reign.
  select min(t.effective_date) into v_next
    from public.training_maxes t
   where t.user_id = old.user_id
     and t.exercise_id = old.exercise_id
     and t.effective_date > old.effective_date
     and t.id <> old.id;

  if exists (
    select 1
      from public.v_live_sets s
      join public.prescriptions p on p.id = s.prescription_id
     where s.user_id = old.user_id
       and s.exercise_id = old.exercise_id
       and p.load_pct_tm is not null
       and s.set_type in ('working', 'backoff')
       and (s.performed_at at time zone app_tz(old.user_id))::date >= old.effective_date
       and (v_next is null
            or (s.performed_at at time zone app_tz(old.user_id))::date < v_next)
  ) then
    raise exception using
      errcode = '23514',
      message = 'this training max was in force for logged sets, so changing or removing it would rewrite their history',
      hint = 'Add a new training max dated from today instead.';
  end if;

  return coalesce(new, old);
end
$$;

revoke all on function public.refuse_rewriting_used_training_max() from public, anon, authenticated;

-- DB-1: deleting an account cascades auth.users -> prescriptions before it
-- reaches sets, so this trigger saw the logged sets and refused the delete.
-- Same short-circuit as the training-max trigger: when the owner is already
-- gone (the cascade), there is no history left to protect. DEFINER for the
-- same reason as above; the existence test must not depend on who is asking.
-- A user's own delete of a prescription that has sets still raises 23001.
create or replace function public.refuse_orphaning_logged_sets()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

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

revoke all on function public.refuse_orphaning_logged_sets() from public, anon, authenticated;
