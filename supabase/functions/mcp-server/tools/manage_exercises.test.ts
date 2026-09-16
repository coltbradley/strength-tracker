//   deno test --allow-env --allow-net tools/manage_exercises.test.ts
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { ToolError } from "../lib/errors.ts";
import { TEST_USER, toolHarness } from "../lib/testing.ts";
import {
  assertInstructionsAllowed,
  registerManageExercises,
} from "./manage_exercises.ts";

const h = (name: string, fixtures: Record<string, unknown[]> = {}) =>
  toolHarness(registerManageExercises, name, fixtures);

// --- assertInstructionsAllowed (pure) ---------------------------------------

Deno.test("a custom exercise may have its instructions set", () => {
  assertInstructionsAllowed("custom"); // does not throw
});

Deno.test(
  "a seeded or edited exercise refuses instructions and points at set_exercise_note",
  () => {
    for (const source of ["free-exercise-db", "curated", "edited"]) {
      const err = assertThrows(
        () => assertInstructionsAllowed(source),
        ToolError,
      );
      assertEquals(err.message.includes(source), true);
      assertEquals(err.message.includes("set_exercise_note"), true);
    }
  },
);

// --- add_exercise ------------------------------------------------------------

Deno.test(
  "add_exercise writes instructions when given, [] when not",
  async () => {
    const withInstructions = h("add_exercise");
    await withInstructions.run({
      name: "Pallof Press",
      primary_muscles: ["abdominals"],
      equipment: "cable",
      instructions: ["Set the cable at chest height.", "Press straight out."],
    });
    const insert1 = withInstructions.calls[0].insert as Record<string, unknown>;
    assertEquals(insert1.instructions, [
      "Set the cable at chest height.",
      "Press straight out.",
    ]);

    const withoutInstructions = h("add_exercise");
    await withoutInstructions.run({
      name: "Pallof Press",
      primary_muscles: ["abdominals"],
      equipment: "cable",
    });
    const insert2 = withoutInstructions.calls[0].insert as Record<
      string,
      unknown
    >;
    assertEquals(insert2.instructions, []);
  },
);

// --- update_exercise ----------------------------------------------------------

Deno.test(
  "update_exercise accepts instructions on a caller-owned custom row",
  async () => {
    const t = h("update_exercise", {
      exercises: [
        {
          id: "Pallof_Press",
          name: "Pallof Press",
          source: "custom",
          exercise_owners: { user_id: TEST_USER },
        },
      ],
    });
    const result = await t.run({
      id: "Pallof_Press",
      instructions: ["Brace the core.", "Press out and back."],
    });
    assertEquals(result.isError, undefined);
    const update = t.calls[1].update as Record<string, unknown>;
    assertEquals(update.instructions, [
      "Brace the core.",
      "Press out and back.",
    ]);
  },
);

Deno.test("update_exercise refuses instructions on a seeded row", async () => {
  const t = h("update_exercise", {
    exercises: [
      {
        id: "Barbell_Squat",
        name: "Barbell Squat",
        source: "free-exercise-db",
        exercise_owners: null,
      },
    ],
  });
  const result = await t.run({
    id: "Barbell_Squat",
    instructions: ["New step"],
  });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "set_exercise_note");
  // No update was attempted: the second call, if any, would be the write.
  assertEquals(t.calls.length, 1, "refused before any write");
});

Deno.test(
  "update_exercise refuses instructions on an edited (still-shared) row",
  async () => {
    const t = h("update_exercise", {
      exercises: [
        {
          id: "Barbell_Squat",
          name: "Barbell Back Squat",
          source: "edited",
          exercise_owners: null,
        },
      ],
    });
    const result = await t.run({
      id: "Barbell_Squat",
      instructions: ["New step"],
    });
    assertEquals(result.isError, true);
  },
);

Deno.test(
  "update_exercise refuses instructions on another user's custom exercise, as unknown",
  async () => {
    const t = h("update_exercise", {
      exercises: [
        {
          id: "Owner_Only_Lift",
          name: "Owner Only Lift",
          source: "custom",
          exercise_owners: { user_id: "00000000-0000-4000-8000-000000000099" },
        },
      ],
    });
    const result = await t.run({ id: "Owner_Only_Lift", instructions: ["x"] });
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "No exercise");
  },
);

Deno.test("update_exercise is still destructive-hinted", () => {
  assertEquals(h("update_exercise").meta.readOnly, false);
});
