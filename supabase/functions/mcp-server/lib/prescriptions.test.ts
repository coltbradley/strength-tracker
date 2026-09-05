// The row builder both plan-writing tools share. Order is the thing worth
// pinning: adjacency is how ramps, supersets and sections are encoded, so a
// builder that reorders or renumbers wrongly reshapes the workout silently.
//
//   deno test --allow-env --allow-net lib/

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { ToolError } from "./errors.ts";
import {
  assertSupersetGroups,
  prescriptionRows,
  prescriptionSchema,
} from "./prescriptions.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const DAY = "22222222-0000-4000-8000-000000000001";

const base = {
  exercise_id: "Barbell_Squat",
  sets: 3,
  reps_min: 5,
  reps_max: 5,
};

Deno.test("position comes from array order, not from the caller", () => {
  const rows = prescriptionRows(OWNER, DAY, [
    { ...base, exercise_id: "A" },
    { ...base, exercise_id: "B" },
    { ...base, exercise_id: "C" },
  ]);
  assertEquals(
    rows.map((r) => [r.exercise_id, r.position]),
    [
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ],
  );
});

Deno.test("a caller-supplied position is ignored rather than trusted", () => {
  // The schema strips it; even if one leaks through, order still wins.
  const parsed = prescriptionSchema.parse({ ...base, position: 7 });
  assertEquals("position" in parsed, false);
});

Deno.test("owner and day are stamped on every row", () => {
  const rows = prescriptionRows(OWNER, DAY, [base, base]);
  for (const r of rows) {
    assertEquals(r.user_id, OWNER);
    assertEquals(r.planned_workout_id, DAY);
  }
});

Deno.test(
  "set_type and tracking are omitted when unsaid, so the column default stands",
  () => {
    const [row] = prescriptionRows(OWNER, DAY, [base]);
    assertEquals("set_type" in row, false);
    assertEquals("tracking" in row, false);

    const [explicit] = prescriptionRows(OWNER, DAY, [
      { ...base, set_type: "warmup", tracking: "done" },
    ]);
    assertEquals(explicit.set_type, "warmup");
    assertEquals(explicit.tracking, "done");
  },
);

Deno.test("absent optional fields become null, not undefined", () => {
  const [row] = prescriptionRows(OWNER, DAY, [base]);
  for (const k of [
    "load_kg",
    "load_pct_tm",
    "load_entry",
    "rest_seconds",
    "notes",
    "superset_group",
    "section",
  ]) {
    assertEquals(row[k], null, `${k} should be null`);
  }
});

Deno.test(
  "an empty list produces no rows, which is how a day is cleared",
  () => {
    assertEquals(prescriptionRows(OWNER, DAY, []), []);
  },
);

Deno.test(
  "schema rejects the load contradictions the DB would reject opaquely",
  () => {
    assertThrows(() =>
      prescriptionSchema.parse({ ...base, load_kg: 100, load_pct_tm: 80 }),
    );
    assertThrows(() =>
      prescriptionSchema.parse({ ...base, reps_min: 8, reps_max: 5 }),
    );
    // per_side with no load has no side to halve
    assertThrows(() =>
      prescriptionSchema.parse({ ...base, load_entry: "per_side" }),
    );
  },
);

Deno.test(
  "per_side survives with a load, and doubles nothing on its own",
  () => {
    const [row] = prescriptionRows(OWNER, DAY, [
      { ...base, load_kg: 60, load_entry: "per_side" },
    ]);
    // 60 is the TOTAL the caller already doubled; the builder never touches it.
    assertEquals(row.load_kg, 60);
    assertEquals(row.load_entry, "per_side");
  },
);

// A superset group of one. Not a schema question -- "is anything else in
// group A" is a fact about the whole day, so it is checked over the list.

Deno.test("a superset group with one member is refused", () => {
  const err = assertThrows(
    () =>
      assertSupersetGroups(
        [
          { ...base, exercise_id: "Barbell_Row", superset_group: 1 },
          { ...base, exercise_id: "Barbell_Curl" },
        ],
        "day 0",
      ),
    ToolError,
  );
  // The message has to name the day and the exercise, or the model cannot
  // tell WHICH half of the pairing went missing.
  assertEquals(err.message.includes("day 0"), true);
  assertEquals(err.message.includes("Barbell_Row"), true);
  // Groups are reported as the letters the coach wrote, not as 1/2/3.
  assertEquals(err.message.includes("superset_group A"), true);
});

Deno.test("a real pairing passes, and so does a day with no groups", () => {
  assertSupersetGroups(
    [
      { ...base, exercise_id: "Barbell_Row", superset_group: 1 },
      { ...base, exercise_id: "Push_Up", superset_group: 1 },
    ],
    "day 0",
  );
  assertSupersetGroups([base, base], "day 0");
  assertSupersetGroups([], "day 0");
});

Deno.test("members of one group need not be adjacent to count", () => {
  // Adjacency is how the app RENDERS a superset, but the group is what makes
  // it one; a check that required adjacency would reject a legal parse.
  assertSupersetGroups(
    [
      { ...base, exercise_id: "A1", superset_group: 1 },
      { ...base, exercise_id: "Filler" },
      { ...base, exercise_id: "A2", superset_group: 1 },
    ],
    "day 0",
  );
});

Deno.test("every lonely group is reported at once, in group order", () => {
  const err = assertThrows(
    () =>
      assertSupersetGroups(
        [
          { ...base, exercise_id: "C_only", superset_group: 3 },
          { ...base, exercise_id: "A_only", superset_group: 1 },
          { ...base, exercise_id: "B_one", superset_group: 2 },
          { ...base, exercise_id: "B_two", superset_group: 2 },
        ],
        "this day",
      ),
    ToolError,
  );
  // One call, one list: fixing A and coming back to be told about C is two
  // round trips for a parse the model can correct in one.
  assertEquals(
    err.message.indexOf("A_only") < err.message.indexOf("C_only"),
    true,
  );
  assertEquals(err.message.includes("B_one"), false);
});

// PostgREST bulk inserts use the UNION of keys across the array and fill a
// missing key with NULL, not the column default. A single explicit set_type on
// one row therefore turned every other row's omitted set_type into NULL in a
// NOT NULL column: three 500s on a real "Lower + Activation" day. The builder
// must emit BOTH defaulted columns on EVERY row, so the array is homogeneous.
Deno.test("set_type and tracking are present on every row, defaulted, never omitted", () => {
  const rows = prescriptionRows(OWNER, DAY, [
    { ...base, exercise_id: "Band_Walk", set_type: "warmup", tracking: "done" },
    { ...base, exercise_id: "Barbell_Squat" },
    { ...base, exercise_id: "Leg_Curl", set_type: "backoff" },
  ]);
  assertEquals(
    rows.map((r) => [r.exercise_id, r.set_type, r.tracking]),
    [
      ["Band_Walk", "warmup", "done"],
      ["Barbell_Squat", "working", "reps"],
      ["Leg_Curl", "backoff", "reps"],
    ],
  );
  // every row carries the same key set, which is what PostgREST needs
  const keys = rows.map((r) => Object.keys(r).sort().join(","));
  assertEquals(new Set(keys).size, 1);
  for (const r of rows) {
    assertEquals("set_type" in r, true);
    assertEquals("tracking" in r, true);
  }
});

