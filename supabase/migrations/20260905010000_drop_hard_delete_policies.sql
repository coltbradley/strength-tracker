-- The soft-delete work was done, and the hard-delete doors were left open.
--
-- 20260831060000 gave `programs` a discarded_at, and 20260901030000 gave
-- `planned_workouts` one, both for the same reason: prescriptions cascade from
-- planned_workouts (schema.sql:78) and sets.prescription_id is ON DELETE SET
-- NULL (schema.sql:114), so ONE hard delete of a planned day cascaded to its
-- prescriptions and silently severed the link from every set ever logged
-- against them. The sets survived. What the plan ASKED for did not, and `sets`
-- is append-only, so nothing could put it back — v_adherence, and the
-- "3x3-5 @ 144 KG" line History renders above each session, were gone for
-- good.
--
-- Both migrations changed how the CODE deletes. Neither dropped the policy
-- that let the database do it. `programs_delete` and `pw_delete`
-- (20260825120002_rls.sql:43,48) have been sitting there the whole time, so a
-- PostgREST DELETE as the ordinary authenticated user still performs exactly
-- the destruction those two migrations were written to make impossible. The
-- PWA no longer takes that path, but the PWA is not the boundary: anyone
-- holding a session token speaks to PostgREST directly, and RLS is the only
-- thing standing between that token and the cascade.
--
-- Deny-by-default is how this schema already expresses append-only (`sets` has
-- no update or delete policy; neither does `sessions`; neither does
-- `set_voids`). Removing a policy is the enforcement mechanism, not a
-- workaround for one.
drop policy programs_delete on programs;
drop policy pw_delete on planned_workouts;

-- Templates are the one planned_workouts delete that is not the incident
-- above, and the PWA performs it today (deleteTemplate, pwa/src/lib/data.ts).
-- A template is dateless by construction
-- (planned_workouts_template_has_no_date), it never appears on a calendar, and
-- applying one COPIES its prescriptions onto a real day — so nothing has ever
-- been logged against a template's own prescriptions, and there is no
-- adherence history under it to sever. Discarding it instead would leave a
-- deleted template in the picker's index forever for no gain.
--
-- Narrowed rather than left alone, because the danger was never "delete" as a
-- verb, it was deleting a DATED day. The check is on is_template, which
-- cannot change to true for a scheduled day and cannot be set on a day that
-- has one.
create policy pw_delete_template on planned_workouts
  for delete to authenticated
  using (user_id = auth.uid() and is_template);

comment on policy pw_delete_template on planned_workouts is
  'The only hard delete left on this table: a saved template, which no set '
  'can ever have been logged against. A dated day is discarded '
  '(discarded_at), never deleted. Note that RLS refuses by returning zero '
  'rows, not an error, so a DELETE aimed at a dated day silently affects '
  'nothing.';

-- Same failure shape, one table over. exercise_owners is what makes a custom
-- exercise readable: exercises_read admits a 'custom' row only when an owner
-- row exists for auth.uid(). Deleting your own ownership row therefore does
-- not "unshare" the exercise, it makes the exercise readable by NOBODY —
-- including you — while every set, prescription, training max and goal
-- pointing at it stays behind. That is precisely the state 20260901010000 had
-- to write a repair pass for, arrived at from the other direction, and it
-- takes v_resolved_prescriptions' inner join on exercises with it: every
-- prescription naming the movement leaves the plan.
--
-- Nothing in the PWA or the MCP server deletes from this table. Ownership ends
-- the way it began: with the exercise. Deleting the exercise cascades the
-- owner row (exercise_id references exercises on delete cascade), and deleting
-- the account cascades it too.
drop policy exercise_owners_delete on exercise_owners;

-- NOT dropped: rx_delete on prescriptions. Removing one exercise from a day is
-- an ordinary plan edit, the PWA does it (deletePrescription,
-- pwa/src/lib/data.ts), and the case that would sever history is already
-- refused row by row by the prescriptions_keep_logged_history trigger
-- (20260901030000). A prescription nothing has been logged against still
-- deletes freely, which is the whole point.
