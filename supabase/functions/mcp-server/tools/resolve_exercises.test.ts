// The batch name-to-id lookup, tested where the decisions actually are.
//
// resolveNames is a function of rows the caller already fetched, so the whole
// of "which exercise does this name mean" is exercised here with no database,
// no port and no network, the same reason lib/handler.ts is separate from
// index.ts.
//
//   deno test --allow-env --allow-net tools/

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { ToolError } from "../lib/errors.ts";
import {
  assertResolvableNames,
  type LibraryRow,
  MAX_NAMES,
  resolveNames,
  type TrainedFact,
} from "./resolve_exercises.ts";

const ME = "00000000-0000-4000-8000-000000000001";
const SOMEONE_ELSE = "00000000-0000-4000-8000-000000000002";

/** A seeded row: shared with everybody, no owner. */
function seeded(id: string, name: string, equipment = "barbell"): LibraryRow {
  return {
    id,
    name,
    equipment,
    source: "free-exercise-db",
    exercise_owners: null,
  };
}

/** A custom row: private to the one person who made it. */
function custom(id: string, name: string, owner: string): LibraryRow {
  return {
    id,
    name,
    equipment: "dumbbell",
    source: "custom",
    exercise_owners: [{ user_id: owner }],
  };
}

/** Rows arrive from the query in name order; keep the fixtures that way. */
const LIBRARY = [
  seeded("Barbell_Bench_Press", "Barbell Bench Press"),
  seeded("Barbell_Squat", "Barbell Squat"),
  seeded("Bench_Press", "Bench Press"),
  seeded("Face_Pull", "Face Pull", "cable"),
  seeded("Front_Squat", "Front Squat"),
  seeded("Lat_Pulldown", "Lat Pulldown", "cable"),
];

function trainedMap(
  entries: [string, string, number?][],
): Map<string, TrainedFact> {
  return new Map(
    entries.map(([id, last, sets]) => [
      id,
      { last_trained: last, logged_sets: sets ?? 1 },
    ]),
  );
}

Deno.test("every name comes back, in the order it was sent", () => {
  const names = ["face pull", "lat pulldown", "front squat"];
  const out = resolveNames(names, LIBRARY, new Map(), ME);
  assertEquals(
    out.map((r) => r.query),
    names,
  );
  assertEquals(
    out.map((r) => r.exercise_id),
    ["Face_Pull", "Lat_Pulldown", "Front_Squat"],
  );
});

Deno.test("a name that matches nothing is reported, not dropped", () => {
  // The reason this tool returns entries rather than results: a model that
  // sent four names and got three back cannot tell which one it lost, and the
  // failure mode of guessing is a program prescribing the wrong movement.
  const out = resolveNames(
    ["face pull", "zercher good morning", "lat pulldown"],
    LIBRARY,
    new Map(),
    ME,
  );
  assertEquals(out.length, 3);
  assertEquals(out[1].status, "unmatched");
  assertEquals(out[1].query, "zercher good morning");
  assertEquals(out[1].exercise_id, undefined);
  assertEquals(typeof out[1].reason, "string");
  // The names either side still resolved; one miss does not poison the batch.
  assertEquals(out[0].exercise_id, "Face_Pull");
  assertEquals(out[2].exercise_id, "Lat_Pulldown");
});

Deno.test("a name of nothing but punctuation is unmatched, not a crash", () => {
  // safeFilterTerm strips it to empty, which as a filter would have matched
  // the entire library and called that a resolution.
  const out = resolveNames(["%%%"], LIBRARY, new Map(), ME);
  assertEquals(out[0].status, "unmatched");
  assertEquals(out[0].query, "%%%");
});

Deno.test(
  "the batch bound is refused with a message, not a schema error",
  () => {
    const tooMany = Array.from(
      { length: MAX_NAMES + 1 },
      (_, i) => `lift ${i}`,
    );
    const err = assertThrows(() => assertResolvableNames(tooMany), ToolError);
    // The model has to be told what to do next, or it retries the same call.
    assertEquals(err.message.includes(String(MAX_NAMES)), true);
    assertEquals(err.message.includes("Split the list"), true);

    assertThrows(() => assertResolvableNames([]), ToolError);
    assertEquals(
      assertResolvableNames(Array.from({ length: MAX_NAMES }, () => "squat"))
        .length,
      MAX_NAMES,
    );
  },
);

Deno.test("another person's custom exercise does not exist here", () => {
  // The server is the service role and RLS is not in the path, so the query
  // returns everybody's custom rows. Reporting it as forbidden would confirm
  // it exists; it has to read as UNKNOWN.
  const rows = [
    ...LIBRARY,
    custom("Coach_Special", "Coach Special", SOMEONE_ELSE),
  ];
  const out = resolveNames(["coach special"], rows, new Map(), ME);
  assertEquals(out[0].status, "unmatched");
  assertEquals(out[0].exercise_id, undefined);
  // The message says nothing about who owns it.
  assertEquals(out[0].reason?.includes(SOMEONE_ELSE), false);
});

Deno.test("my own custom exercise resolves normally", () => {
  const rows = [...LIBRARY, custom("Coach_Special", "Coach Special", ME)];
  const out = resolveNames(["coach special"], rows, new Map(), ME);
  assertEquals(out[0].status, "ok");
  assertEquals(out[0].exercise_id, "Coach_Special");
});

Deno.test("what the lifter trains wins, and wins clearly", () => {
  // "squat" matches two. One is a movement they have a bar loaded for; the
  // other is a variant that would split their history.
  const trained = trainedMap([["Barbell_Squat", "2026-09-01T18:00:00Z", 42]]);
  const out = resolveNames(["squat"], LIBRARY, trained, ME);
  assertEquals(out[0].status, "ok");
  assertEquals(out[0].exercise_id, "Barbell_Squat");
  assertEquals(out[0].trained, true);
  assertEquals(out[0].logged_sets, 42);
  assertEquals(out[0].alternatives, undefined);
});

Deno.test("two untrained variants are ambiguous, with the runners-up", () => {
  // Nothing separates these but the alphabet, and winning on the alphabet is
  // how a plan quietly ends up on the wrong squat.
  const out = resolveNames(["squat"], LIBRARY, new Map(), ME);
  assertEquals(out[0].status, "ambiguous");
  assertEquals(out[0].exercise_id, "Barbell_Squat");
  assertEquals(out[0].trained, false);
  assertEquals(
    out[0].alternatives?.map((a) => a.exercise_id),
    ["Front_Squat"],
  );
});

Deno.test("two trained variants are ambiguous however recent one is", () => {
  // Recency orders them, but both are movements this lifter does; picking one
  // silently is a decision the coach should be making.
  const trained = trainedMap([
    ["Barbell_Squat", "2026-09-01T18:00:00Z"],
    ["Front_Squat", "2026-08-20T18:00:00Z"],
  ]);
  const out = resolveNames(["squat"], LIBRARY, trained, ME);
  assertEquals(out[0].status, "ambiguous");
  assertEquals(out[0].exercise_id, "Barbell_Squat");
  assertEquals(out[0].alternatives?.[0].exercise_id, "Front_Squat");
  assertEquals(out[0].alternatives?.[0].trained, true);
});

Deno.test("an exact name settles it on its own", () => {
  // "face pull" matches exactly one row anyway; "bench press" matches two, and
  // one of them IS that name.
  const out = resolveNames(["bench press"], LIBRARY, new Map(), ME);
  assertEquals(out[0].status, "ok");
  assertEquals(out[0].exercise_id, "Bench_Press");
});

Deno.test(
  "an exact match the ranking did not choose is still ambiguous",
  () => {
    // The trained row leads, because the trained row should lead. But an exact
    // match sitting behind it is the model's cue to ask which one the coach
    // meant, rather than a detail the answer gets to omit.
    const trained = trainedMap([
      ["Barbell_Bench_Press", "2026-09-01T18:00:00Z"],
    ]);
    const out = resolveNames(["bench press"], LIBRARY, trained, ME);
    assertEquals(out[0].status, "ambiguous");
    assertEquals(out[0].exercise_id, "Barbell_Bench_Press");
    assertEquals(
      out[0].alternatives?.map((a) => a.exercise_id),
      ["Bench_Press"],
    );
  },
);

Deno.test("the id slug matches too, so a model can send one back", () => {
  const out = resolveNames(["Lat_Pulldown"], LIBRARY, new Map(), ME);
  assertEquals(out[0].status, "ok");
  assertEquals(out[0].exercise_id, "Lat_Pulldown");
  assertEquals(out[0].equipment, "cable");
});

Deno.test("a repeated name is answered twice, not deduped away", () => {
  // Positional alignment is the contract. Collapsing duplicates would shift
  // every entry after them.
  const out = resolveNames(["face pull", "face pull"], LIBRARY, new Map(), ME);
  assertEquals(out.length, 2);
  assertEquals(
    out.map((r) => r.exercise_id),
    ["Face_Pull", "Face_Pull"],
  );
});
