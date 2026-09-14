// The phase validation set_training_plan runs BEFORE Postgres sees a plan.
//
// The database refuses an overlap with an exclusion-class error, which the
// guard reports as "Unexpected server error": a generic 500 for what is really
// a date the model could fix on the next call. Everything pinned here is pinned
// so the first thing the model sees names the phase and the day.
//
//   deno test --allow-env --allow-net tools/training_plan.test.ts

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { ToolError } from "../lib/errors.ts";
import {
  assertMaySupersede,
  type PhaseInput,
  validatePhases,
} from "./training_plan.ts";

const phase = (
  name: string,
  starts_on: string,
  ends_on: string,
): PhaseInput => ({ name, starts_on, ends_on });

Deno.test("adjacent phases pass and the plan's dates derive from them", () => {
  const dates = validatePhases(
    [
      phase("Accumulation", "2026-09-01", "2026-10-12"),
      phase("Intensification", "2026-10-13", "2026-11-23"),
    ],
    {},
  );
  assertEquals(dates, { starts_on: "2026-09-01", ends_on: "2026-11-23" });
});

Deno.test(
  "a gap between phases is allowed — a rest week is a real thing to plan",
  () => {
    const dates = validatePhases(
      [
        phase("Block 1", "2026-09-01", "2026-09-28"),
        phase("Block 2", "2026-10-06", "2026-11-02"),
      ],
      {},
    );
    assertEquals(dates.ends_on, "2026-11-02");
  },
);

Deno.test(
  "phases sharing one day overlap: bounds are inclusive at both ends",
  () => {
    const err = assertThrows(
      () =>
        validatePhases(
          [
            phase("Accumulation", "2026-09-01", "2026-10-12"),
            phase("Intensification", "2026-10-12", "2026-11-23"),
          ],
          {},
        ),
      ToolError,
    );
    // Names both phases and says what to do, not just "invalid".
    assertEquals(err.message.includes("Accumulation"), true);
    assertEquals(err.message.includes("Intensification"), true);
    assertEquals(err.message.includes("overlap"), true);
  },
);

Deno.test(
  "phases out of chronological order are refused as ORDER, not as overlap",
  () => {
    const err = assertThrows(
      () =>
        validatePhases(
          [
            phase("Later", "2026-10-13", "2026-11-23"),
            phase("Earlier", "2026-09-01", "2026-10-12"),
          ],
          {},
        ),
      ToolError,
    );
    assertEquals(err.message.includes("chronological order"), true);
  },
);

Deno.test("a phase that ends before it starts is refused", () => {
  assertThrows(
    () => validatePhases([phase("Backwards", "2026-10-12", "2026-09-01")], {}),
    ToolError,
    "ends",
  );
});

Deno.test(
  "an impossible calendar date is refused by name, not by Postgres",
  () => {
    assertThrows(
      () => validatePhases([phase("Feb", "2026-02-01", "2026-02-30")], {}),
      ToolError,
      "phases[0].ends_on",
    );
  },
);

Deno.test("explicit plan dates must contain every phase", () => {
  assertThrows(
    () =>
      validatePhases([phase("Peak", "2026-11-24", "2026-12-20")], {
        starts_on: "2026-09-01",
        ends_on: "2026-12-01",
      }),
    ToolError,
    "outside the plan's own dates",
  );
  // ...and may run past the last phase when later ones are not decided yet.
  const dates = validatePhases(
    [phase("Accumulation", "2026-09-01", "2026-10-12")],
    { ends_on: "2027-03-31" },
  );
  assertEquals(dates, { starts_on: "2026-09-01", ends_on: "2027-03-31" });
});

Deno.test("a plan with no phases is refused", () => {
  assertThrows(() => validatePhases([], {}), ToolError, "at least one phase");
});

// set_training_plan supersedes the live plan the moment it is called, before
// the new one is confirmed. When the live plan is CONFIRMED that is a change to
// the strategy the user is following, so it takes the same confirm_change gate
// as editing a confirmed program's day.

const livePlan = (confirmed_at: string | null) => ({
  id: "11111111-1111-4111-8111-111111111111",
  objective: "Squat 200 kg by March",
  confirmed_at,
});

Deno.test("with no live plan there is nothing to supersede and no gate", () => {
  assertMaySupersede(null, false);
});

Deno.test("an unconfirmed draft is superseded freely, as before", () => {
  assertMaySupersede(livePlan(null), false);
});

Deno.test("a confirmed plan is refused without confirm_change, and says to ask first", () => {
  const err = assertThrows(
    () => assertMaySupersede(livePlan("2026-09-05T10:00:00Z"), false),
    ToolError,
  );
  assertEquals(err.message.includes("CONFIRMED"), true);
  assertEquals(err.message.includes("Squat 200 kg by March"), true);
  assertEquals(err.message.includes("approval in chat"), true);
  assertEquals(err.message.includes("confirm_change=true"), true);
});

Deno.test("a confirmed plan is superseded once the change is confirmed", () => {
  assertMaySupersede(livePlan("2026-09-05T10:00:00Z"), true);
});
