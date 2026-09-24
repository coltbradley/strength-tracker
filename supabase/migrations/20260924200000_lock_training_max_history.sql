-- A-203: a training max that logged sets depended on is history.
--
-- v_adherence resolves a %TM prescription against the max in force on the
-- day the set was performed (the latest effective_date on or before it).
-- Deleting that max, or changing its value, date or exercise, silently
-- changed a past set's prescribed load, its delta and its hit/miss outcome.
-- That is the same rewrite the prescription lock (20260924042220) refuses,
-- so the same answer applies: refuse it, and let the person add a new max
-- dated from today instead.
--
-- Inserts stay free. A new max only resolves sets on or after its own date,
-- and a first max set after a calibration session is exactly how an
-- unresolved %TM becomes a number (AGENTS.md, load_pct_tm).

create or replace function public.refuse_rewriting_used_training_max()
returns trigger
language plpgsql
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

create trigger training_maxes_keep_history
  before update or delete on public.training_maxes
  for each row execute function public.refuse_rewriting_used_training_max();
