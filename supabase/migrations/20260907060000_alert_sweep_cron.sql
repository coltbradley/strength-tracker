-- The scheduler for prompt delivery, in Supabase.
--
-- `push-alerts/sweep` sends whatever is due. Something has to call it. This is
-- that something: pg_cron fires a Postgres function, which uses pg_net to POST
-- to the edge function, with the credentials read from Vault at RUN time.
--
-- Verified against the project before writing (2026-09-07): pg_cron 1.6.4 and
-- pg_net 0.20.4 are available but not installed; supabase_vault 0.3.1 is
-- installed. So this migration installs the two and leaves the third alone.
--
-- GUARDED, because this repository's validation path is the whole migration
-- chain replayed in PGlite (scripts/validate-db.mjs), and PGlite has none of
-- these three. A bare `create extension pg_cron` would fail there and take the
-- entire gate with it. `pg_available_extensions` is a catalog view PGlite does
-- have, so asking it first turns this file into a no-op there and a real
-- install on Supabase, with one body of SQL rather than two that can drift.
-- The same trick would let plan_phases use the exclusion constraint it wanted
-- (btree_gist is available on the project and absent in PGlite); that is
-- deliberately left alone, because the trigger it settled for works.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end
$$;

-- What the cron actually runs.
--
-- A function rather than an inline `net.http_post` in the cron command, for two
-- reasons: the command string is then short enough to read in
-- `cron.job`, and the MISSING-SECRET case can be handled honestly. An unset
-- secret makes this do nothing and say so, rather than firing a request with an
-- empty header every five minutes forever and collecting 401s nobody reads.
create or replace function run_alert_sweep() returns void
  language plpgsql
  security definer
  set search_path = public, extensions, vault, pg_temp
  as $$
  declare
    base_url text;
    secret   text;
  begin
    -- Vault, not a column and not a migration literal: this is a credential,
    -- and a credential in a committed migration is a credential in a public
    -- repository. `decrypted_secrets` is readable only by roles that can reach
    -- the vault schema, which is why this function is SECURITY DEFINER.
    select decrypted_secret into base_url
      from vault.decrypted_secrets where name = 'project_url';
    select decrypted_secret into secret
      from vault.decrypted_secrets where name = 'sweep_secret';

    if base_url is null or secret is null then
      raise notice 'alert sweep skipped: project_url or sweep_secret missing from vault';
      return;
    end if;

    perform net.http_post(
      url     := base_url || '/functions/v1/push-alerts/sweep',
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        -- The function authenticates on this and nothing else. It answers the
        -- sweep route BEFORE its session check, because the caller is a machine
        -- with no Supabase session to offer.
        'x-sweep-secret',  secret
      ),
      body    := '{}'::jsonb,
      -- Fire and forget with a short ceiling. pg_net is async: this returns a
      -- request id immediately and the response lands in net._http_response.
      -- The sweep is idempotent, so a timeout costs a retry next tick and
      -- never a double send.
      timeout_milliseconds := 5000
    );
  end
  $$;

comment on function run_alert_sweep() is
  'Calls push-alerts/sweep so due prompts are delivered. Reads project_url and '
  'sweep_secret from Vault at run time; does nothing (with a notice) when '
  'either is missing, rather than firing unauthenticated requests forever. '
  'Scheduled by pg_cron as the job "alert-sweep".';

-- Nothing but the scheduler should be able to make Postgres do this.
revoke all on function run_alert_sweep() from public, anon, authenticated;

-- Every five minutes, not every minute.
--
-- The prompts this delivers are daily and weekly, so five minutes of latency on
-- a 07:30 reminder is invisible, and it is a twelfth of the wake-ups. The sweep
-- itself has a six-hour grace window, so a tick that is missed entirely costs
-- nothing as long as another lands inside that window.
--
-- Unscheduled first so re-running this migration (or editing the cadence in a
-- later one) replaces the job rather than erroring on the duplicate name.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('alert-sweep')
      where exists (select 1 from cron.job where jobname = 'alert-sweep');
    perform cron.schedule('alert-sweep', '*/5 * * * *', 'select run_alert_sweep()');
  end if;
end
$$;
