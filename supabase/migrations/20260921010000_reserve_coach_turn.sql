-- Reserve a coach turn in one transaction so concurrent requests cannot both
-- pass a count-then-insert quota check.

create or replace function reserve_coach_turn(
  p_user_id uuid,
  p_turn_id uuid,
  p_day_limit int,
  p_month_token_limit numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
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

revoke all on function reserve_coach_turn(uuid, uuid, int, numeric) from public, authenticated;

-- PGlite replay paths (check-selects, validate-db without the role shim) have no
-- service_role; Supabase always does. Guard so one migration body works everywhere.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function reserve_coach_turn(uuid, uuid, int, numeric) to service_role;
  end if;
end
$$;
