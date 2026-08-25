-- Row level security. Policies are deny-by-default; the absence of a policy
-- IS the enforcement mechanism for append-only tables:
--   * sets:     insert + select only (no update, no delete -> append-only)
--   * sessions: insert + select + update (end-of-session edits), no delete
--   * exercises: global read; inserts allowed for custom entries
-- MCP writes to planned tables go through the service role (bypasses RLS) but
-- are pinned to a single user id in edge-function code. RLS here protects the
-- PWA path, which always runs as the authenticated user.

alter table exercises        enable row level security;
alter table training_maxes   enable row level security;
alter table goals            enable row level security;
alter table programs         enable row level security;
alter table planned_workouts enable row level security;
alter table prescriptions    enable row level security;
alter table sessions         enable row level security;
alter table sets             enable row level security;

-- exercises: shared library
create policy exercises_read on exercises
  for select to authenticated using (true);
create policy exercises_insert_custom on exercises
  for insert to authenticated with check (source = 'custom');

-- training_maxes: owner CRUD (values change, corrections are legitimate)
create policy tm_select on training_maxes for select to authenticated using (user_id = auth.uid());
create policy tm_insert on training_maxes for insert to authenticated with check (user_id = auth.uid());
create policy tm_update on training_maxes for update to authenticated using (user_id = auth.uid());
create policy tm_delete on training_maxes for delete to authenticated using (user_id = auth.uid());

-- goals: owner CRUD
create policy goals_select on goals for select to authenticated using (user_id = auth.uid());
create policy goals_insert on goals for insert to authenticated with check (user_id = auth.uid());
create policy goals_update on goals for update to authenticated using (user_id = auth.uid());
create policy goals_delete on goals for delete to authenticated using (user_id = auth.uid());

-- programs / planned_workouts / prescriptions: owner read; owner write kept
-- open so a future in-app editor isn't blocked by the database, but today only
-- the MCP server (service role) writes them.
create policy programs_select on programs for select to authenticated using (user_id = auth.uid());
create policy programs_insert on programs for insert to authenticated with check (user_id = auth.uid());
create policy programs_update on programs for update to authenticated using (user_id = auth.uid());
create policy programs_delete on programs for delete to authenticated using (user_id = auth.uid());

create policy pw_select on planned_workouts for select to authenticated using (user_id = auth.uid());
create policy pw_insert on planned_workouts for insert to authenticated with check (user_id = auth.uid());
create policy pw_update on planned_workouts for update to authenticated using (user_id = auth.uid());
create policy pw_delete on planned_workouts for delete to authenticated using (user_id = auth.uid());

create policy rx_select on prescriptions for select to authenticated using (user_id = auth.uid());
create policy rx_insert on prescriptions for insert to authenticated with check (user_id = auth.uid());
create policy rx_update on prescriptions for update to authenticated using (user_id = auth.uid());
create policy rx_delete on prescriptions for delete to authenticated using (user_id = auth.uid());

-- sessions: no delete policy on purpose
create policy sessions_select on sessions for select to authenticated using (user_id = auth.uid());
create policy sessions_insert on sessions for insert to authenticated with check (user_id = auth.uid());
create policy sessions_update on sessions for update to authenticated using (user_id = auth.uid());

-- sets: append-only. No update or delete policy on purpose. Do not add one.
create policy sets_select on sets for select to authenticated using (user_id = auth.uid());
create policy sets_insert on sets for insert to authenticated with check (user_id = auth.uid());
