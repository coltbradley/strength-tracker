//   deno test --allow-env --allow-net tools/set_training_max.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { toolHarness } from "../lib/testing.ts";
import { registerSetTrainingMax } from "./set_training_max.ts";

Deno.test(
  "MCP-2: a same-date overwrite refused by the TM-history trigger (23514) tells the model to use a new date",
  async () => {
    const t = toolHarness(
      registerSetTrainingMax,
      "set_training_max",
      {
        exercises: [
          {
            id: "Barbell_Squat",
            name: "Barbell Squat",
            source: "curated",
            exercise_owners: null,
          },
        ],
        v_current_tm: [{ value_kg: 100, effective_date: "2026-09-01" }],
      },
      undefined,
      undefined,
      {
        errors: {
          training_maxes: {
            code: "23514",
            message: "training max is in use by logged sets",
            hint: "Add a new training max dated from today instead.",
          },
        },
      },
    );
    const res = await t.run({
      exercise_id: "Barbell_Squat",
      value_kg: 110,
      effective_date: "2026-09-01",
    });
    assertEquals(res.isError, true);
    const text = res.content[0].text;
    assert(!text.includes("Unexpected server error"), text);
    assertStringIncludes(text, "Add a new training max dated from today");
  },
);
