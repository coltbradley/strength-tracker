// Valentine's plan as it stood on 2026-08-31, reconstructed from production.
// Two states: EARLY (turns 1-3: LEGS had only the goblet squat and the single
// leg RDL) and LATE (turns 4-13: she had filled LEGS in by hand). SESSION adds
// an open session with a few logged sets for the mid-workout cases.

export const OWNER = "00000000-0000-4000-8000-00000000ea01";
export const PROGRAM = "11111111-0000-4000-8000-00000000ea01";
const day = (n) => `22222222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

const PUSH = [
  ["Dumbbell_Bench_Press", 3, 8, 8, 9.06, null],
  ["Dumbbell_Shoulder_Press", 3, 8, 8, 13.6, 1],
  ["Cable_Incline_Triceps_Extension", 3, 8, 8, 18.14, 1],
  ["Arnold_Dumbbell_Press", 3, 8, 8, 9.06, 2],
  ["Side_Lateral_Raise", 3, 8, 8, 6.79, 2],
];
const LEGS_EARLY = [
  ["Goblet_Squat", 3, 8, 8, 20.41, null],
  ["Single_Leg_Romanian_Deadlift", 3, 8, 8, 13.6, null],
];
const LEGS_LATE = [
  ["Goblet_Squat", 3, 8, 8, 20.41, null],
  ["Single_Leg_Romanian_Deadlift", 3, 8, 8, 13.6, 1],
  ["Bulgarian_Split_Squat", 3, 8, 8, 11.33, 1],
  ["Single_Leg_Hip_Thrust", 3, 8, 8, null, 2],
  ["Bodyweight_Walking_Lunge", 3, 8, 8, 18.14, 2],
];

function rxRows(dayId, rows) {
  return rows
    .map(
      ([ex, sets, lo, hi, load, group], i) =>
        `('${OWNER}', '${dayId}', '${ex}', ${i}, ${sets}, ${lo}, ${hi}, ${load === null ? "null" : load}, ${group === null ? "null" : group}, 60)`,
    )
    .join(",\n");
}

/** Wipe everything that belongs to the fixture user and rebuild the state. */
export async function applyFixture(db, state) {
  const legs = state === "early" ? LEGS_EARLY : LEGS_LATE;
  await db.exec(`
    delete from set_notes where set_id in (select id from sets where user_id = '${OWNER}');
    delete from set_voids where set_id in (select id from sets where user_id = '${OWNER}');
    delete from sets where user_id = '${OWNER}';
    delete from sessions where user_id = '${OWNER}';
    delete from prescriptions where user_id = '${OWNER}';
    delete from planned_workouts where user_id = '${OWNER}';
    delete from programs where user_id = '${OWNER}';
    delete from coach_memory where user_id = '${OWNER}';
    delete from goals where user_id = '${OWNER}';
    delete from training_maxes where user_id = '${OWNER}';
    delete from feedback where user_id = '${OWNER}';
    delete from exercise_notes where user_id = '${OWNER}';
    delete from exercises where id in (select exercise_id from exercise_owners where user_id = '${OWNER}');
    delete from user_config where user_id = '${OWNER}';
    insert into auth.users (id, email) values ('${OWNER}', 'valentine@example.test') on conflict do nothing;
    insert into user_config (user_id, tz) values ('${OWNER}', 'America/Los_Angeles');

    insert into programs (id, user_id, name, source_note, confirmed_at, created_at)
      values ('${PROGRAM}', '${OWNER}', 'My plan', 'Created in the app', '2026-08-31T02:08:50Z', '2026-08-31T02:08:50Z');
    insert into planned_workouts (id, user_id, program_id, day_index, label, scheduled_date) values
      ('${day(0)}', '${OWNER}', '${PROGRAM}', 0, null,   '2026-08-30'),
      ('${day(1)}', '${OWNER}', '${PROGRAM}', 1, 'PUSH', '2026-08-31'),
      ('${day(4)}', '${OWNER}', '${PROGRAM}', 4, 'LEGS', '2026-09-01'),
      ('${day(6)}', '${OWNER}', '${PROGRAM}', 6, 'PULL', '2026-09-03');
    insert into prescriptions (user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg, superset_group, rest_seconds) values
      ${rxRows(day(1), PUSH)},
      ${rxRows(day(4), legs)};
  `);
  if (state === "session") {
    // A LEGS session in progress: goblet squat done, RDL half done.
    await db.exec(`
      insert into sessions (id, user_id, planned_workout_id, started_at)
        values ('44444444-0000-4000-8000-00000000ea01', '${OWNER}', '${day(4)}', '2026-09-02T11:17:00Z');
      insert into sets (id, user_id, session_id, exercise_id, prescription_id, set_index, set_type, load_kg, reps, performed_at, load_entry)
      select gen_random_uuid(), '${OWNER}', '44444444-0000-4000-8000-00000000ea01', 'Goblet_Squat', p.id, s.i, 'working', 20.41, 10,
             ('2026-09-02T11:17:34Z'::timestamptz + (s.i * interval '2 minutes')), 'total'
        from prescriptions p, generate_series(0, 2) as s(i)
       where p.planned_workout_id = '${day(4)}' and p.exercise_id = 'Goblet_Squat';
      insert into sets (id, user_id, session_id, exercise_id, prescription_id, set_index, set_type, load_kg, reps, performed_at, load_entry)
      select gen_random_uuid(), '${OWNER}', '44444444-0000-4000-8000-00000000ea01', 'Single_Leg_Romanian_Deadlift', p.id, 0, 'working', 13.61, 9,
             '2026-09-02T11:29:13Z', 'total'
        from prescriptions p
       where p.planned_workout_id = '${day(4)}' and p.exercise_id = 'Single_Leg_Romanian_Deadlift';
    `);
  }
}

/** What the PWA would have put in the context block for each state. */
export function contextFor(state) {
  if (state === "session") {
    return [
      "Today is 2026-09-02. Weights below are shown in lb.",
      "",
      "A SESSION IS IN PROGRESS (LEGS), started 2026-09-02T11:17:00.000Z.",
      "4 sets logged so far, most recent last:",
      "  - Goblet_Squat: 45 lb x 10 (working)",
      "  - Goblet_Squat: 45 lb x 10 (working)",
      "  - Goblet_Squat: 45 lb x 10 (working)",
      "  - Single_Leg_Romanian_Deadlift: 30 lb x 9 (working)",
      "",
      "SCHEDULED TODAY: LEGS",
      "  - Goblet Squat: 3x8 @ 45 lb",
      "  - Single Leg Romanian Deadlift: 3x8 @ 30 lb [superset A]",
      "  - Bulgarian Split Squat: 3x8 @ 25 lb [superset A]",
      "  - Single Leg Hip Thrust: 3x8 @ by feel [superset B]",
      "  - Bodyweight Walking Lunge: 3x8 @ 40 lb [superset B]",
      "",
      "This is what the app has cached on their phone right now. It covers today only — use your tools for history, trends, other days, or anything you are unsure of.",
    ].join("\n");
  }
  // Verbatim what her phone sent on 2026-08-31 (evening of the 30th, Pacific).
  return [
    "Today is 2026-08-30. Weights below are shown in lb.",
    "",
    "No session is running right now.",
    "",
    "SCHEDULED TODAY: Workout 1",
    "",
    "This is what the app has cached on their phone right now. It covers today only — use your tools for history, trends, other days, or anything you are unsure of.",
  ].join("\n");
}
