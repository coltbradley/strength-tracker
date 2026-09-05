// The loop's pure rules. What is worth pinning is STRUCTURE: a repeat that
// carries last time's loads and order forward must not tear a ramp, split a
// section, or move an exercise nobody did.
//
//   deno test lib/loop.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import {
  entryOrder,
  firstPerformedAt,
  jaccard,
  lastWorkingLoads,
  type LoggedSet,
  orderDiffers,
  performedOrder,
  readsAsInstruction,
  refreshedLoads,
  reorderByPerformed,
  type RxRow,
  SIMILARITY_THRESHOLD,
} from "./loop.ts";

const rx = (
  exercise_id: string,
  position: number,
  extra: Partial<RxRow> = {},
): RxRow => ({
  exercise_id,
  position,
  sets: 3,
  reps_min: 8,
  reps_max: 10,
  load_kg: null,
  load_pct_tm: null,
  load_entry: null,
  rest_seconds: null,
  notes: null,
  superset_group: null,
  section: null,
  set_type: "working",
  tracking: "reps",
  ...extra,
});

const set = (
  exercise_id: string,
  performed_at: string,
  extra: Partial<LoggedSet> = {},
): LoggedSet => ({
  exercise_id,
  set_index: 0,
  set_type: "working",
  load_kg: 100,
  load_entry: "total",
  reps: 5,
  performed_at,
  ...extra,
});

// ---- similarity -------------------------------------------------------------

Deno.test("jaccard: identical sets are 1, disjoint are 0, empty is 0 not NaN", () => {
  assertEquals(jaccard(["a", "b"], ["b", "a"]), 1);
  assertEquals(jaccard(["a"], ["b"]), 0);
  assertEquals(jaccard([], []), 0);
});

Deno.test("jaccard: the threshold admits a day with one swap, refuses a shared pair", () => {
  // nine exercises, one swapped out: 8 / 10
  const day = "abcdefghi".split("");
  const swapped = "abcdefghX".split("");
  assertEquals(jaccard(day, swapped) >= SIMILARITY_THRESHOLD, true);
  // nine exercises sharing squats and rows with a five-exercise day: 2 / 12
  assertEquals(jaccard(day, ["a", "b", "x", "y", "z"]) < SIMILARITY_THRESHOLD, true);
  // duplicates in the input (a ramp lists its exercise three times) are one
  assertEquals(jaccard(["a", "a", "a", "b"], ["a", "b"]), 1);
});

// ---- notes that are really instructions -------------------------------------

Deno.test("readsAsInstruction: the notes from the real session", () => {
  // Colt's leg-extension warmup note, 2026-09-05
  assertEquals(readsAsInstruction("Could be more, maybe 70?"), true);
  // the band note the design doc wants turned into an exercise cue
  assertEquals(readsAsInstruction("grey band too light, use strong"), true);
  assertEquals(readsAsInstruction("go up next time"), true);
  assertEquals(readsAsInstruction("Try 32.5 next session"), true);
});

Deno.test("readsAsInstruction: facts about the set stay facts", () => {
  assertEquals(readsAsInstruction("These are with bands, not actual weight"), false);
  assertEquals(readsAsInstruction("felt heavy"), false);
  assertEquals(readsAsInstruction("sleep wasn't great"), false);
  assertEquals(readsAsInstruction("left knee clicked on rep 3"), false);
  assertEquals(readsAsInstruction(""), false);
  assertEquals(readsAsInstruction("   "), false);
});

// ---- last time's loads -------------------------------------------------------

Deno.test("lastWorkingLoads: the LATEST working set, not the heaviest", () => {
  const loads = lastWorkingLoads([
    set("squat", "2026-09-05T10:00:00Z", { load_kg: 100 }),
    set("squat", "2026-09-05T10:05:00Z", { load_kg: 110 }),
    // backed off after a grind: the back-off is what they meant
    set("squat", "2026-09-05T10:10:00Z", { load_kg: 105 }),
    set("squat", "2026-09-05T09:50:00Z", { load_kg: 60, set_type: "warmup" }),
    set("band", "2026-09-05T09:40:00Z", { load_kg: 0 }),
  ]);
  assertEquals(loads.get("squat"), 105);
  // a tick / bodyweight row is a working set at 0 and reports 0; refreshedLoads
  // ignores a 0 (see below), so nothing gets zeroed
  assertEquals(loads.get("band"), 0);
});

Deno.test("refreshedLoads: a straight scheme moves to last time's number", () => {
  assertEquals(
    refreshedLoads([rx("squat", 0, { load_kg: 100 })], new Map([["squat", 110]])),
    [110],
  );
});

Deno.test("refreshedLoads: a ramp is rescaled, never flattened", () => {
  // Same fixture as the PWA's templateLoads.test.ts — the two rules must agree.
  const out = refreshedLoads(
    [
      rx("squat", 0, { load_kg: 60, set_type: "warmup" }),
      rx("squat", 1, { load_kg: 85, set_type: "warmup" }),
      rx("squat", 2, { load_kg: 112.5 }),
    ],
    new Map([["squat", 110]]),
  );
  assertEquals(out, [58.5, 83, 110]);
});

Deno.test("refreshedLoads: %TM, no-load and never-logged rows are left alone", () => {
  const out = refreshedLoads(
    [
      rx("squat", 0, { load_pct_tm: 80 }),
      rx("band", 1),
      rx("row", 2, { load_kg: 60 }),
      rx("done", 3, { load_kg: 40 }),
    ],
    new Map([["squat", 120], ["band", 0], ["done", 0]]),
  );
  // %TM untouched, no-load untouched, row never logged untouched, and a last
  // load of 0 (a tick, a bodyweight set) is not a number to scale to
  assertEquals(out, [null, null, null, null]);
});

// ---- performed order ---------------------------------------------------------

Deno.test("performedOrder: by FIRST touch, so alternated supersets keep their order", () => {
  const sets = [
    set("a1", "T10:00"),
    set("a2", "T10:02"),
    set("a1", "T10:04"),
    set("a2", "T10:06"),
    set("c", "T09:00"),
  ];
  assertEquals(performedOrder(sets), ["c", "a1", "a2"]);
  assertEquals(firstPerformedAt(sets).get("a1"), "T10:00");
});

Deno.test("reorderByPerformed: D and E swap when E was done first (the real day)", () => {
  // Plan order was D (leg extensions) then E (ATG split squat); Colt did E
  // first. The repeat should put E first and SAY so.
  const rows = [rx("legext", 0), rx("atg", 1)];
  const r = reorderByPerformed(
    rows,
    new Map([["atg", "T10:00"], ["legext", "T10:20"]]),
  );
  assertEquals(entryOrder(r.rows), ["atg", "legext"]);
  assertEquals(r.rows.map((x) => x.position), [0, 1]);
  assertEquals(r.changed, true);
});

Deno.test("reorderByPerformed: a ramp moves as one entry", () => {
  const rows = [
    rx("squat", 0, { load_kg: 60, set_type: "warmup" }),
    rx("squat", 1, { load_kg: 100 }),
    rx("row", 2),
  ];
  const r = reorderByPerformed(rows, new Map([["row", "T1"], ["squat", "T2"]]));
  assertEquals(
    r.rows.map((x) => [x.exercise_id, x.load_kg]),
    [["row", null], ["squat", 60], ["squat", 100]],
  );
});

Deno.test("reorderByPerformed: an exercise nobody did keeps its slot", () => {
  const rows = [rx("a", 0), rx("skipped", 1), rx("c", 2)];
  const r = reorderByPerformed(rows, new Map([["c", "T1"], ["a", "T2"]]));
  // c and a swap around the untouched middle slot
  assertEquals(entryOrder(r.rows), ["c", "skipped", "a"]);
});

Deno.test("reorderByPerformed: a named section stays one block and is ordered inside", () => {
  const rows = [
    rx("band1", 0, { section: "Activations" }),
    rx("band2", 1, { section: "Activations" }),
    rx("squat", 2),
    rx("row", 3),
  ];
  // did the main work first, then activations, and band2 before band1
  const r = reorderByPerformed(
    rows,
    new Map([
      ["squat", "T1"],
      ["row", "T2"],
      ["band2", "T3"],
      ["band1", "T4"],
    ]),
  );
  assertEquals(
    r.rows.map((x) => [x.exercise_id, x.section]),
    [
      ["squat", null],
      ["row", null],
      ["band2", "Activations"],
      ["band1", "Activations"],
    ],
  );
  // the section is still ONE contiguous run, so it renders as one block
  const sections = r.rows.map((x) => x.section);
  assertEquals(sections.lastIndexOf(null) < sections.indexOf("Activations"), true);
});

Deno.test("reorderByPerformed: nothing performed means nothing moves", () => {
  const rows = [rx("a", 0), rx("b", 1)];
  const r = reorderByPerformed(rows, new Map());
  assertEquals(entryOrder(r.rows), ["a", "b"]);
  assertEquals(r.changed, false);
});

Deno.test("reorderByPerformed: same order as planned reports unchanged", () => {
  const rows = [rx("a", 0), rx("b", 1)];
  const r = reorderByPerformed(rows, new Map([["a", "T1"], ["b", "T2"]]));
  assertEquals(r.changed, false);
});

Deno.test("orderDiffers: only exercises in both lists count", () => {
  assertEquals(orderDiffers(["d", "e"], ["e", "d"]), true);
  assertEquals(orderDiffers(["a", "b", "c"], ["a", "c"]), false);
  assertEquals(orderDiffers(["a", "b"], ["a", "extra", "b"]), false);
  assertEquals(orderDiffers(["a", "a", "b"], ["a", "b"]), false);
  assertEquals(orderDiffers(["a", "b"], []), false);
});
