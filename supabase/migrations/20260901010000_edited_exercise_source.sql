-- An edited library exercise became invisible to everybody.
--
-- update_exercise re-tags a seeded row source='custom' on edit, so that a
-- re-seed cannot revert the edit (each seed only updates rows still carrying
-- its own source tag). That rule was written before 20260827180000_multi_user
-- made 'custom' mean "belongs to one person":
--
--   exercises_read:  source <> 'custom'
--                    or exists (owner row for auth.uid())
--
-- A re-tagged row satisfies neither branch. The claim trigger fires `after
-- insert` only, and the MCP path that does the re-tagging is the service role,
-- which has no auth.uid() to claim it with — so no owner row is ever written.
-- The row is readable by nobody, and because v_resolved_prescriptions inner
-- joins exercises, every prescription naming that movement silently leaves the
-- plan. requireExercise then reports the id UNKNOWN, so set_training_max,
-- set_goal and set_exercise_note start refusing a movement that plainly exists
-- and has history behind it.
--
-- The bug is that one column carries two unrelated facts: WHO may read the row,
-- and WHICH seed may overwrite it. Editing a shared row only ever meant to
-- change the second. So this gives that fact its own value.
--
--   'free-exercise-db'  generated seed        shared, that seed may rewrite it
--   'curated'           hand-maintained seed  shared, that seed may rewrite it
--   'edited'            was seeded, edited    shared, NO seed may rewrite it
--   'custom'            somebody's own        private to its exercise_owners row
--
-- Nothing about the policies has to change: every one of them, and
-- assertVisible in the MCP server, already branches on `= 'custom'` vs
-- `<> 'custom'`, and 'edited' lands on the correct side of all six. An edited
-- library row therefore stays readable by everyone, stays un-deletable and
-- un-editable from the PWA (both policies require source = 'custom' AND
-- ownership), and is skipped by both seeds.

-- 1. Repair the rows already lost.
--
-- An unowned 'custom' row is readable by NOBODY today — not even whoever made
-- it — so these rows are inert, not private. Two things produce them: a seeded
-- row re-tagged by update_exercise (the bug above), and migration 8's backfill,
-- which deliberately left a custom exercise unclaimed when no set, prescription,
-- training max or goal pointed at it (20260827180000_multi_user.sql:162-170).
-- Nothing distinguishes the two after the fact.
--
-- They are moved to 'edited', which makes them shared library rows again. That
-- is plainly right for the first group. For the second it means an unused
-- custom movement's NAME becomes visible to other accounts, which is the
-- deliberate trade: the alternative leaves rows that no human being can see,
-- including their author, and that reference-nothing state is not privacy, it
-- is data loss. Nothing but the name is exposed, and a movement name carries
-- no personal detail.
update exercises e
   set source = 'edited'
 where e.source = 'custom'
   and not exists (
     select 1 from exercise_owners o where o.exercise_id = e.id
   );

-- 2. Close the column, now that the vocabulary is finite and load-bearing.
--
-- RLS branches on this string. Until now a typo — 'Custom', 'custum' — made a
-- private row public (source <> 'custom' is true for both), which is the same
-- class of failure as the one above running the other way.
alter table exercises
  add constraint exercises_source_known
  check (source in ('free-exercise-db', 'curated', 'edited', 'custom'));

comment on column exercises.source is
  'Which seed, if any, owns this row, and whether it is shared. '
  '''free-exercise-db'' and ''curated'' are seeds and may be rewritten by them. '
  '''edited'' is a seeded row a human changed: shared, but no seed may revert it. '
  '''custom'' is private to the account in exercise_owners.';
