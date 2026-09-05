// Put the database into the state a case starts from. Shared by run.mjs (the
// API driver) and serve.mjs (the subagent driver) so the two never drift.

import { applyFixture, OWNER } from "./fixture.mjs";

export async function setupCase(db, c) {
  await applyFixture(db, c.state);
  if (c.setup === "write_pull_unconfirmed") {
    // What v12 leaves behind: a second, unconfirmed "My plan" with all three days.
    await db.exec(`
      insert into programs (id, user_id, name, confirmed_at) values
        ('11111111-0000-4000-8000-00000000ea02', '${OWNER}', 'My plan', null);
      insert into planned_workouts (id, user_id, program_id, day_index, label, scheduled_date) values
        ('22222222-0000-4000-8000-00000000ee01', '${OWNER}', '11111111-0000-4000-8000-00000000ea02', 1, 'PUSH', '2026-09-01'),
        ('22222222-0000-4000-8000-00000000ee04', '${OWNER}', '11111111-0000-4000-8000-00000000ea02', 4, 'LEGS', '2026-09-02'),
        ('22222222-0000-4000-8000-00000000ee06', '${OWNER}', '11111111-0000-4000-8000-00000000ea02', 6, 'PULL', '2026-09-03');
      insert into prescriptions (user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, superset_group, rest_seconds) values
        ('${OWNER}', '22222222-0000-4000-8000-00000000ee06', 'One-Arm_Dumbbell_Row', 0, 3, 8, 8, null, 60),
        ('${OWNER}', '22222222-0000-4000-8000-00000000ee06', 'Assisted_Pull_Up_Machine', 1, 3, 5, 8, 1, 60),
        ('${OWNER}', '22222222-0000-4000-8000-00000000ee06', 'Reverse_Flyes', 2, 3, 8, 8, 1, 60),
        ('${OWNER}', '22222222-0000-4000-8000-00000000ee06', 'Dumbbell_Bicep_Curl', 3, 3, 8, 8, 2, 60),
        ('${OWNER}', '22222222-0000-4000-8000-00000000ee06', 'Hammer_Curls', 4, 3, 8, 8, 2, 60);
    `);
  }
}
