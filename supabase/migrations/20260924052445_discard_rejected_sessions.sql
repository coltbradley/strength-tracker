-- The End screen must be able to distinguish a transient/offline discard
-- from a permanent refusal caused by a late-arriving set. 23514 is already
-- classified by the PWA outbox as a row-level rejection, so it stays visible
-- for export but is not offered for retry forever.
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
    raise exception using errcode = '23514',
      message = 'cannot discard a session that contains sets',
      hint = 'Sessions with logged sets remain part of training history.';
  end if;
  return new;
end
$$;
