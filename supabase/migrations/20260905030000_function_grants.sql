-- Two findings from the first run of Supabase's database linter against
-- production (docs/security.md, "Database linter baseline").
--
-- 1. purge_expired_mcp_tokens() could be called by ANYONE.
--
--    It is SECURITY DEFINER because it has to be: it deletes from mcp_tokens,
--    which no client role may touch. Supabase grants EXECUTE on every new
--    public function to anon and authenticated by default, and Postgres grants
--    it to PUBLIC by default, so /rest/v1/rpc/purge_expired_mcp_tokens was an
--    unauthenticated write endpoint. Bounded by its own WHERE clause to tokens
--    already expired more than a day, so no working credential was ever at
--    risk — but its only caller is the coach function, which runs as the
--    service role, and nothing else should be able to make Postgres do work on
--    request. Revoked from PUBLIC too: the `=X/postgres` entry in the ACL is the
--    public grant, and revoking from the two named roles alone leaves it
--    standing. service_role keeps EXECUTE; it is not named here and is not
--    PUBLIC.
--
-- 2. The five SECURITY INVOKER functions had no search_path.
--
--    Hygiene rather than a hole — they run as the caller, so there is nothing
--    to escalate to — but pinning it costs nothing and closes the lint.
--    `public, pg_temp` rather than `public`: pg_temp is searched FIRST unless
--    it is listed, so a caller's temp table named user_config would otherwise
--    shadow the real one inside app_tz. Everything these functions name lives
--    in public or is schema-qualified (auth.uid()), and pg_catalog is always
--    searched first regardless, so nothing changes meaning.

revoke execute on function public.purge_expired_mcp_tokens()
  from public, anon, authenticated;

alter function public.app_tz() set search_path = public, pg_temp;
alter function public.app_tz(uuid) set search_path = public, pg_temp;
alter function public.claim_custom_exercise() set search_path = public, pg_temp;
alter function public.refuse_orphaning_logged_sets() set search_path = public, pg_temp;
alter function public.stamp_exercise_edit() set search_path = public, pg_temp;
