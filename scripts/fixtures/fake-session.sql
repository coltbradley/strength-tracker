-- Smoke-test fixture: one plausible squat session so Claude has something to
-- analyze before the PWA exists (build plan phase 2/4).
-- Run in the Supabase dashboard SQL editor AFTER replacing :owner below with
-- your auth.users uuid. Idempotent: fixed uuids + on conflict do nothing.
-- Remove later with: delete from sessions where id = 'f0000000-0000-4000-8000-000000000001';

with owner as (select ':owner'::uuid as id)  -- <<< replace :owner

, tm as (
  insert into training_maxes (user_id, exercise_id, value_kg, effective_date)
  select id, 'Barbell_Squat', 150, current_date - 14 from owner
  on conflict (user_id, exercise_id, effective_date) do nothing
)
, sess as (
  insert into sessions (id, user_id, started_at, ended_at, session_rpe, bodyweight_kg, notes)
  select 'f0000000-0000-4000-8000-000000000001', id,
         now() - interval '2 days 1 hour', now() - interval '2 days', 7, 82.5,
         'fixture session (smoke test)'
  from owner
  on conflict (id) do nothing
)
insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps, performed_at)
select v.id::uuid, o.id, 'f0000000-0000-4000-8000-000000000001', v.exercise_id,
       v.set_index, v.set_type::set_type, v.load_kg, v.reps,
       now() - interval '2 days 1 hour' + v.offset_min * interval '1 minute'
from owner o,
(values
  ('f0000000-0000-4000-8000-000000000101', 'Barbell_Squat', 0, 'warmup',  60.0,  8,  5),
  ('f0000000-0000-4000-8000-000000000102', 'Barbell_Squat', 1, 'warmup',  90.0,  5,  9),
  ('f0000000-0000-4000-8000-000000000103', 'Barbell_Squat', 2, 'working', 120.0, 5, 14),
  ('f0000000-0000-4000-8000-000000000104', 'Barbell_Squat', 3, 'working', 120.0, 5, 18),
  ('f0000000-0000-4000-8000-000000000105', 'Barbell_Squat', 4, 'working', 120.0, 4, 23),
  ('f0000000-0000-4000-8000-000000000106', 'Barbell_Squat', 5, 'backoff', 100.0, 8, 27),
  ('f0000000-0000-4000-8000-000000000107', 'Romanian_Deadlift', 6, 'working', 100.0, 8, 33),
  ('f0000000-0000-4000-8000-000000000108', 'Romanian_Deadlift', 7, 'working', 100.0, 8, 37)
) as v(id, exercise_id, set_index, set_type, load_kg, reps, offset_min)
on conflict (id) do nothing;
