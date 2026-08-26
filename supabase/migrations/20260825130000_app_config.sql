-- Deployment config as a table, replacing the app.tz GUC.
-- Managed Postgres (Supabase) denies `alter database ... set` for custom
-- GUCs even to the postgres role (superuser-only for placeholder GUCs), so
-- the database-level setting the original app_tz() relied on cannot be set
-- in production. A one-row config table needs no privileges beyond DML.
-- See docs/decisions.md.

create table app_config (
  key   text primary key,
  value text not null
);

alter table app_config enable row level security;

-- Views run security_invoker as the authenticated user, so app_tz() must be
-- readable on that path. No insert/update/delete policies: config is written
-- by the service role or the dashboard only.
create policy app_config_read on app_config
  for select to authenticated using (true);

insert into app_config (key, value) values ('tz', 'UTC');

-- Same contract as before: the user's home timezone for calendar bucketing,
-- UTC when unset. Set it with:
--   update app_config set value = 'America/Los_Angeles' where key = 'tz';
create or replace function app_tz() returns text
  language sql stable
  as $$
    select coalesce((select value from app_config where key = 'tz'), 'UTC')
  $$;
