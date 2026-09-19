-- Six FK-adjacent columns with no index leading on them, in the style of
-- 20260901020000_hot_path_indexes.sql and 20260906000000_void_and_note_indexes.sql:
-- no behaviour changes, each one because a real read filters on the column
-- alone and Postgres does not index a referencing column for you.
--
-- Checked against every existing index before adding any of these (a leading
-- column already covering the filter means the new index buys nothing and
-- only costs writes):
--   sets            idx_sets_history (user_id, exercise_id, performed_at desc),
--                   idx_sets_user_recent (user_id, performed_at desc),
--                   idx_sets_session (session_id, performed_at),
--                   idx_sets_prescription (prescription_id) — none lead with
--                   exercise_id alone.
--   prescriptions   idx_rx_workout (planned_workout_id, position) — leads
--                   with neither exercise_id nor user_id.
--   training_maxes  idx_tm_lookup (user_id, exercise_id, effective_date desc)
--                   — leads with user_id, not exercise_id.
--   goals           idx_goals_user (user_id, exercise_id) — leads with
--                   user_id, not exercise_id.
--   exercise_notes  primary key (user_id, exercise_id) — leads with user_id,
--                   not exercise_id.
-- So all six are additive; none is skipped.

-- 1. Sets by exercise, across all sessions. get_lift_history and the coach's
-- per-exercise reads filter on exercise_id (often alongside user_id, but
-- idx_sets_history's column ORDER puts exercise_id second, so a query that
-- filters on exercise_id without also pinning user_id first — or where the
-- planner prefers a narrower index — cannot use it).
create index idx_sets_exercise on sets (exercise_id);

-- 2. Prescriptions by exercise. get_session_diff and any "when was this
-- exercise prescribed" read filters on exercise_id alone; idx_rx_workout is
-- keyed by day, not by movement.
create index idx_rx_exercise on prescriptions (exercise_id);

-- 3. Prescriptions by owner. Several tools (get_program, update_planned_workout,
-- find_similar_days) scan a user's own prescriptions without pinning a
-- specific planned_workout_id first; idx_rx_workout cannot serve that.
create index idx_rx_user on prescriptions (user_id);

-- 4. Training maxes by exercise, across all users — the read
-- get_goal_progress and get_trends' e1RM-vs-TM context would run if either
-- ever asks "who has a TM on this lift" without a user_id in hand.
create index idx_tm_exercise on training_maxes (exercise_id);

-- 5. Goals by exercise, same reasoning: idx_goals_user cannot serve a query
-- that filters on exercise_id alone.
create index idx_goals_exercise on goals (exercise_id);

-- 6. Exercise notes by exercise. get_exercise_notes and any future "who has
-- written a note on this movement" read filters on exercise_id alone; the
-- primary key (user_id, exercise_id) cannot serve that without a user_id.
create index idx_exercise_notes_exercise on exercise_notes (exercise_id);
