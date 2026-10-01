-- Goals may only point at an exercise the caller can see.
--
-- The goals policies shipped with the original RLS migration (20260825120002):
-- insert/update proved `user_id = auth.uid()` and nothing about the exercise.
-- The FK's own check bypasses RLS, so an insert for a guessable id (ids are
-- name slugs) answered "success" for another user's PRIVATE custom exercise
-- and "23503" for a missing one: an existence oracle by slug. Worse, that row
-- then blocks the owner's delete_exercise (goals reference exercises without
-- cascade), a griefing vector that needs only a guessed slug.
--
-- The Version D Record screen made pinning (a goal) a first-class direct PWA
-- write, so the same visibility rule exercise_prefs already has
-- (20261001000000) is applied here. The subquery runs under the caller's RLS,
-- so `exercises_read` (source <> 'custom' or an exercise_owners row for me)
-- decides, and another person's private exercise fails EXACTLY like a
-- nonexistent id: the policy refuses (42501) before the FK is consulted.
--
-- Policies are replaced, not edited in place: 20260825120002 is applied and
-- stays as it was. Select and delete are unchanged (owner only). The MCP
-- server writes goals with the service role, which bypasses RLS; its own
-- exercise check is unchanged. Existing rows are untouched (policies do not
-- run over stored data); only new inserts and updates are held to the rule.

drop policy goals_insert on goals;
create policy goals_insert on goals for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from exercises e where e.id = exercise_id)
  );

drop policy goals_update on goals;
create policy goals_update on goals for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from exercises e where e.id = exercise_id)
  );
