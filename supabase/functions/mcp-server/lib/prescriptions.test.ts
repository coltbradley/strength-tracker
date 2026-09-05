// The row builder both plan-writing tools share. Order is the thing worth
// pinning: adjacency is how ramps, supersets and sections are encoded, so a
// builder that reorders or renumbers wrongly reshapes the workout silently.
//
//   deno test --allow-env --allow-net lib/

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { prescriptionRows, prescriptionSchema } from "./prescriptions.ts";

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
