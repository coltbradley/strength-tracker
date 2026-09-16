//   deno test --allow-env --allow-net tools/get_session_diff.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { payload, TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerGetSessionDiff } from "./get_session_diff.ts";

const SESSION_ID = "44444444-0000-4000-8000-000000000001";
const RX_SQUAT = "33333333-0000-4000-8000-000000000001"; // prescribed working
const RX_WARMUP = "33333333-0000-4000-8000-000000000002"; // prescribed warmup

const h = (fixtures = {}) =>
  toolHarness(registerGetSessionDiff, "get_session_diff", fixtures);

const baseFixtures = (): Record<string, unknown[]> => ({
  sessions: [
    {
      id: SESSION_ID,
      planned_workout_id: "22222222-0000-4000-8000-000000000001",
    },
  ],
  prescriptions: [
    {
      id: RX_SQUAT,
      exercise_id: "Barbell_Squat",
      set_type: "working",
      reps_min: 5,
      reps_max: 5,
      exercises: { name: "Barbell Squat" },
    },
    {
      id: RX_WARMUP,
      exercise_id: "Barbell_Squat",
      set_type: "warmup",
      reps_min: 8,
      reps_max: 10,
      exercises: { name: "Barbell Squat" },
    },
  ],
  v_live_sets: [],
  v_adherence: [],
  session_skips: [],
});

Deno.test(
  "unknown or foreign session_id is a ToolError naming get_recent_sessions",
  async () => {
    const t = h({ sessions: [] });
    const result = await t.run({ session_id: SESSION_ID });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "get_recent_sessions");
  },
);

Deno.test("a session with no plan returns every set as unplanned", async () => {
  const t = h({
    sessions: [{ id: SESSION_ID, planned_workout_id: null }],
    v_live_sets: [
      {
        id: "s1",
        exercise_id: "Barbell_Squat",
        prescription_id: null,
        set_index: 0,
        set_type: "working",
        load_kg: 100,
        reps: 5,
        performed_at: "2026-09-16T10:00:00Z",
      },
    ],
    v_adherence: [],
    session_skips: [],
  });
  const body = payload(await t.run({ session_id: SESSION_ID }));
  assertEquals(body.data.had_plan, false);
  assertEquals(body.data.prescriptions, []);
  assertEquals(body.data.unplanned_sets.length, 1);
  assertEquals(body.data.unplanned_sets[0].exercise_id, "Barbell_Squat");
});

Deno.test(
  "a swapped exercise is reported against the prescription that named the original",
  async () => {
    const f = baseFixtures();
    f.v_live_sets = [
      {
        id: "s1",
        exercise_id: "Leg_Press",
        prescription_id: RX_SQUAT,
        set_index: 0,
        set_type: "working",
        load_kg: 150,
        reps: 5,
        performed_at: "2026-09-16T10:00:00Z",
      },
    ];
    const t = h(f);
    const body = payload(await t.run({ session_id: SESSION_ID }));
    const squat = body.data.prescriptions.find(
      (p: any) => p.prescription_id === RX_SQUAT,
    );
    assertEquals(squat.exercise_swapped, { to_exercise_id: "Leg_Press" });
    assertEquals(squat.performed, true);
  },
);

Deno.test(
  "a warmup prescription logged as working is taken_as_working",
  async () => {
    const f = baseFixtures();
    f.v_live_sets = [
      {
        id: "s1",
        exercise_id: "Barbell_Squat",
        prescription_id: RX_WARMUP,
        set_index: 0,
        set_type: "working",
        load_kg: 60,
        reps: 10,
        performed_at: "2026-09-16T10:00:00Z",
      },
    ];
    const t = h(f);
    const body = payload(await t.run({ session_id: SESSION_ID }));
    const warmup = body.data.prescriptions.find(
      (p: any) => p.prescription_id === RX_WARMUP,
    );
    assertEquals(warmup.taken_as_working, true);
    assertEquals(warmup.taken_as_warmup, false);
  },
);

Deno.test(
  "a working prescription logged only as warmup is taken_as_warmup",
  async () => {
    const f = baseFixtures();
    f.v_live_sets = [
      {
        id: "s1",
        exercise_id: "Barbell_Squat",
        prescription_id: RX_SQUAT,
        set_index: 0,
        set_type: "warmup",
        load_kg: 60,
        reps: 10,
        performed_at: "2026-09-16T10:00:00Z",
      },
    ];
    const t = h(f);
    const body = payload(await t.run({ session_id: SESSION_ID }));
    const squat = body.data.prescriptions.find(
      (p: any) => p.prescription_id === RX_SQUAT,
    );
    assertEquals(squat.taken_as_warmup, true);
    assertEquals(squat.sets, [], "the warmup set carries no load/rep delta");
  },
);

Deno.test(
  "working sets carry the load/rep delta from v_adherence, joined by set_id",
  async () => {
    const f = baseFixtures();
    f.v_live_sets = [
      {
        id: "s1",
        exercise_id: "Barbell_Squat",
        prescription_id: RX_SQUAT,
        set_index: 0,
        set_type: "working",
        load_kg: 120,
        reps: 4,
        performed_at: "2026-09-16T10:00:00Z",
      },
    ];
    f.v_adherence = [
      {
        set_id: "s1",
        prescription_id: RX_SQUAT,
        actual_load_kg: 120,
        actual_reps: 4,
        prescribed_load_kg: 120,
        load_delta_kg: 0,
        rep_outcome: "missed",
      },
    ];
    const t = h(f);
    const body = payload(await t.run({ session_id: SESSION_ID }));
    const squat = body.data.prescriptions.find(
      (p: any) => p.prescription_id === RX_SQUAT,
    );
    assertEquals(squat.sets, [
      {
        set_id: "s1",
        load_kg: 120,
        reps: 4,
        prescribed_load_kg: 120,
        load_delta_kg: 0,
        rep_outcome: "missed",
      },
    ]);
  },
);

Deno.test("skips are returned as recorded, with reasons", async () => {
  const f = baseFixtures();
  f.session_skips = [
    {
      exercise_id: "Barbell_Deadlift",
      prescription_id: null,
      scope: "exercise",
      reason: "Equipment taken",
    },
  ];
  const t = h(f);
  const body = payload(await t.run({ session_id: SESSION_ID }));
  assertEquals(body.data.skips, f.session_skips);
});

Deno.test("every read is scoped to the owner", async () => {
  const t = h(baseFixtures());
  await t.run({ session_id: SESSION_ID });
  for (const call of t.calls) {
    if (
      call.table === "sessions" ||
      call.table === "prescriptions" ||
      call.table === "v_live_sets" ||
      call.table === "v_adherence" ||
      call.table === "session_skips"
    ) {
      assertEquals(
        call.filters.some((f) => f === `eq:user_id=${TEST_USER}`),
        true,
        `${call.table} was not scoped by owner`,
      );
    }
  }
});

Deno.test(
  "the description frames the output as change, not a completion score",
  () => {
    const d = h().meta.description.toLowerCase();
    assertStringIncludes(d, "what changed");
    assertStringIncludes(d, "never");
  },
);

Deno.test("is read-only", () => {
  assertEquals(h().meta.readOnly, true);
});
