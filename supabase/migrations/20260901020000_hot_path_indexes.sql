-- Three indexes for query shapes the app runs constantly and the schema does
-- not currently support. No behaviour changes here; every one of these was
-- checked against a real call site rather than added speculatively.

-- 1. Sessions by the planned day they fulfil.
--
-- `idx_sessions_user` is (user_id, started_at desc), which cannot serve a
-- lookup keyed on planned_workout_id. Six call sites in pwa/src/lib/data.ts
-- filter on it, including the `.in(...)` at data.ts:752 that answers "which of
-- this week's planned days are done" — one of the first queries the app runs
-- on opening, and the one whose answer decides whether a day shows RESUME or
-- "Start again".
--
-- It is also the FK target column. Postgres does not index a referencing
-- column automatically, so deleting a planned_workout scans `sessions` in
-- full to enforce the constraint.
create index idx_sessions_planned on sessions (planned_workout_id)
  where planned_workout_id is not null;

-- 2. Sets by the prescription they fulfil.
--
-- `sets.prescription_id` references prescriptions ON DELETE SET NULL, and the
-- column is unindexed — so deleting ONE prescription sequentially scans the
-- whole of `sets`, the table that grows fastest and never shrinks (it is
-- append-only; voids are separate rows). Editing a plan day deletes
-- prescriptions, so this is on an ordinary user path, and it gets slower for
-- every set the user has ever logged.
create index idx_sets_prescription on sets (prescription_id)
  where prescription_id is not null;

-- 3. A user's whole history, newest first.
--
-- `idx_sets_history` is (user_id, exercise_id, performed_at desc). With
-- exercise_id sitting between the filter and the sort key, it cannot serve a
-- query that filters only on user_id and orders by performed_at — Postgres
-- reads every row the user owns and sorts them. That is exactly what
-- getLastActuals (data.ts:1080) and the logged-exercise scan (data.ts:1057)
-- do, and getLastActuals is what fills in every "last time" line and every
-- prefilled load in a session.
--
-- Both existing indexes stay: this one does not subsume the per-exercise
-- lookup, which is still the better plan when an exercise IS specified.
create index idx_sets_user_recent on sets (user_id, performed_at desc);
