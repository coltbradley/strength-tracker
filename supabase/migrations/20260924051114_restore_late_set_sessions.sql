-- A locally empty session may be discarded while another device still has a
-- set in its offline outbox. If that set reaches the server later, restore
-- the empty session before accepting the append-only set row. Locking the
-- session row defines the order against a concurrent discard:
--   * insert wins first: discard sees the committed set and is refused;
--   * discard wins first: insert waits, then clears discarded_at and appends.

create or replace function public.restore_session_for_late_set()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_discarded_at timestamptz;
begin
  -- A client UUID replay must remain a no-op, including for a legacy row that
  -- might already exist on a discarded session.
  if exists (select 1 from public.sets s where s.id = new.id) then
    return new;
  end if;

  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'set owner does not match caller';
  end if;

  select s.user_id, s.discarded_at
    into v_owner, v_discarded_at
    from public.sessions s
   where s.id = new.session_id
   for update;

  if not found or v_owner is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'session not found';
  end if;

  if v_discarded_at is not null then
    update public.sessions
       set discarded_at = null
     where id = new.session_id
       and user_id = new.user_id
       and discarded_at is not null;
  end if;

  return new;
end
$$;

create trigger sets_restore_session_for_late_set
  before insert on public.sets
  for each row execute function public.restore_session_for_late_set();

-- Discard is only for an accidental, server-confirmed empty start. Once any
-- append-only set row exists, hiding the whole session would remove real
-- training from every view. A late outbox insert uses the trigger above to
-- win this race safely if it arrives after the discard.
create or replace function public.prevent_discard_session_with_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.discarded_at is null
     and new.discarded_at is not null
     and exists (
       select 1 from public.sets s where s.session_id = old.id limit 1
     ) then
    raise exception using errcode = '55000',
      message = 'cannot discard a session that contains sets',
      hint = 'Sessions with logged sets remain part of training history.';
  end if;
  return new;
end
$$;

create trigger sessions_prevent_discard_with_sets
  before update of discarded_at on public.sessions
  for each row execute function public.prevent_discard_session_with_sets();
