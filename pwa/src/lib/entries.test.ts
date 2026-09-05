import { describe, expect, it } from "vitest";
import {
  bracketFor,
  buildEntries,
  groupRamps,
  isLocalBracket,
  isOrphanSet,
  setsForEntry,
  supersetInfo,
  supersetLetter,
  supersetPartner,
  targetSets,
  progressSets,
  entryMet,
  warmupSets,
  workingSets,
  type ExerciseEntry,
} from "./entries";
import type { ResolvedPrescriptionRow, SetInsert } from "./types";

let rxSeq = 0;
function rx(over: Partial<ResolvedPrescriptionRow>): ResolvedPrescriptionRow {
  rxSeq += 1;
  return {
    id: `rx${rxSeq}`,
    planned_workout_id: "w1",
    exercise_id: "squat",
    exercise_name: "Back Squat",
    position: rxSeq,
    sets: 3,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 120,
    notes: null,
    load_kg: 100,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 100,
    plate_load_kg: null,
    superset_group: null,
    ...over,
  };
}

let setSeq = 0;
function set(over: Partial<SetInsert>): SetInsert {
  setSeq += 1;
  return {
    id: `s${setSeq}`,
    session_id: "sess1",
    exercise_id: "squat",
    prescription_id: null,
    set_index: setSeq - 1,
    set_type: "working",
    load_kg: 100,
    reps: 5,
    performed_at: `2026-08-27T10:0${setSeq}:00.000Z`,
    rest_seconds_actual: null,
    ...over,
  };
}

const entry = (over: Partial<ExerciseEntry>): ExerciseEntry => ({
  key: "k",
  exercise_id: "squat",
  name: "Back Squat",
  brackets: [],
  ...over,
});

// ---- groupRamps ------------------------------------------------------------

describe("groupRamps", () => {
  it("collapses a three-bracket ramp into one group", () => {
    const a = rx({ sets: 1, reps_min: 8, reps_max: 15 });
    const b = rx({ sets: 1, reps_min: 6, reps_max: 8 });
    const c = rx({ sets: 3, reps_min: 3, reps_max: 5 });
    expect(groupRamps([a, b, c])).toEqual([[a, b, c]]);
  });

  it("keeps NON-consecutive repeats of one exercise distinct", () => {
    const a = rx({ exercise_id: "squat" });
    const b = rx({ exercise_id: "bench", exercise_name: "Bench" });
    const c = rx({ exercise_id: "squat" });
    expect(groupRamps([a, b, c])).toEqual([[a], [b], [c]]);
  });

  it("keeps consecutive same-exercise rows in DIFFERENT superset groups apart", () => {
    // the clause a rewrite drops: same exercise back to back, one inside the
    // A superset and one outside it, is two entries, not a ramp
    const a = rx({ superset_group: 1 });
    const b = rx({ superset_group: null });
    expect(groupRamps([a, b])).toEqual([[a], [b]]);
  });

  it("groups consecutive same-exercise rows sharing a superset group", () => {
    const a = rx({ superset_group: 1, sets: 1 });
    const b = rx({ superset_group: 1, sets: 2 });
    expect(groupRamps([a, b])).toEqual([[a, b]]);
  });

  it("returns an empty list for an empty plan", () => {
    expect(groupRamps([])).toEqual([]);
  });
});

// ---- bracket walking -------------------------------------------------------

describe("bracketFor / workingSets", () => {
  const ramp = entry({
    brackets: [
      rx({ sets: 1, reps_min: 8, reps_max: 15 }),
      rx({ sets: 1, reps_min: 6, reps_max: 8 }),
      rx({ sets: 3, reps_min: 3, reps_max: 5 }),
    ],
  });

  it("sums prescribed sets across brackets", () => {
    expect(workingSets(ramp)).toBe(5);
    expect(workingSets(entry({ brackets: [] }))).toBe(0);
  });

  it("walks the ramp in order — a wrong bracket is a permanent wrong link", () => {
    // sets 1..5 land in brackets [0,1,2,2,2]
    const ids = [0, 1, 2, 3, 4].map((n) => bracketFor(ramp, n)?.id);
    expect(ids).toEqual([
      ramp.brackets[0].id,
      ramp.brackets[1].id,
      ramp.brackets[2].id,
      ramp.brackets[2].id,
      ramp.brackets[2].id,
    ]);
  });

  it("holds the last bracket for extra sets past the prescription", () => {
    expect(bracketFor(ramp, 9)?.id).toBe(ramp.brackets[2].id);
  });

  it("has no bracket for an unprescribed entry", () => {
    expect(bracketFor(entry({ brackets: [] }), 0)).toBeNull();
  });
});

// ---- warmups are their own run ---------------------------------------------
// The coach's "1×12 @ 10 warmup, then 3×8 @ 20". The target is THREE sets,
// the warmup is its own count, and the two walks never share a cursor: a
// warmup that consumed the first working bracket linked the set to the wrong
// prescription, and `sets` is append-only.

describe("mixed warmup and working brackets", () => {
  const warm = rx({ sets: 1, reps_min: 12, reps_max: 12, set_type: "warmup" });
  const work = rx({ sets: 3, reps_min: 8, reps_max: 8, set_type: "working" });
  const mixed = entry({ brackets: [warm, work] });

  it("counts the two runs separately", () => {
    expect(workingSets(mixed)).toBe(3);
    expect(warmupSets(mixed)).toBe(1);
  });

  it("counts a legacy backoff bracket as work, and an absent type too", () => {
    // `set_type` is optional on rows cached before the column existed;
    // reading those as warmups would empty the target of every such day
    const legacy = entry({
      brackets: [rx({ sets: 2, set_type: "backoff" }), rx({ sets: 2 })],
    });
    expect(workingSets(legacy)).toBe(4);
    expect(warmupSets(legacy)).toBe(0);
  });

  it("walks warmup sets through warmup brackets only", () => {
    expect(bracketFor(mixed, 0, "warmup")?.id).toBe(warm.id);
    // a second warmup past the one prescribed holds the last warmup bracket
    expect(bracketFor(mixed, 1, "warmup")?.id).toBe(warm.id);
  });

  it("starts working set one on the WORKING bracket, not on the warmup", () => {
    // the bug: one cursor for both meant working set 1 prefilled the
    // warmup's 10 kg and linked to the warmup prescription forever
    expect(bracketFor(mixed, 0, "working")?.id).toBe(work.id);
    expect(bracketFor(mixed, 2, "working")?.id).toBe(work.id);
  });

  it("falls back to the whole list when the plan has no bracket of that kind", () => {
    // a warmup taken by feel on a plan that never wrote one still links to
    // the working bracket it leads into, which is the older behaviour
    const plain = entry({ brackets: [work] });
    expect(bracketFor(plain, 0, "warmup")?.id).toBe(work.id);
  });

  it("is done when the WORKING sets are done, warmup logged or not", () => {
    // the target summed the warmup in while only working sets were counted
    // against it, so "1 OF 4" could never reach 4 and the only way to finish
    // the day was to log the warmup as working, at the warmup weight
    expect(targetSets(mixed)).toBe(3);
    const logged = [
      set({ set_type: "warmup" }),
      set({ set_type: "working" }),
      set({ set_type: "working" }),
    ];
    expect(progressSets(mixed, logged)).toBe(2);
    expect(entryMet(mixed, logged)).toBe(false);
    const andOneMore = [...logged, set({ set_type: "working" })];
    expect(progressSets(mixed, andOneMore)).toBe(3);
    expect(entryMet(mixed, andOneMore)).toBe(true);
  });

  it("counts a day of ONLY warmups against its warmups, not against zero", () => {
    // workingSets is 0 there and every count is >= 0, so a prep drill
    // written entirely as warmup sets would be born finished
    const prep = entry({
      brackets: [rx({ sets: 2, set_type: "warmup" })],
    });
    expect(targetSets(prep)).toBe(2);
    expect(entryMet(prep, [])).toBe(false);
    expect(entryMet(prep, [set({ set_type: "warmup" })])).toBe(false);
    expect(
      entryMet(prep, [
        set({ set_type: "warmup" }),
        set({ set_type: "warmup" }),
      ]),
    ).toBe(true);
  });

  it("an unprescribed entry is met by its first logged set", () => {
    const free = entry({ brackets: [] });
    expect(entryMet(free, [])).toBe(false);
    expect(entryMet(free, [set({})])).toBe(true);
    expect(progressSets(free, [set({}), set({})])).toBe(2);
  });
});

// ---- orphan claiming -------------------------------------------------------
// A logged set that no entry renders cannot be voided or corrected: `sets` is
// append-only. docs/decisions.md records this as a real bug once already.

describe("orphan set claiming", () => {
  it("treats a null or dangling prescription_id as orphaned", () => {
    const known = new Set(["rxA"]);
    expect(isOrphanSet(set({ prescription_id: null }), known)).toBe(true);
    expect(isOrphanSet(set({ prescription_id: "gone" }), known)).toBe(true);
    expect(isOrphanSet(set({ prescription_id: "rxA" }), known)).toBe(false);
  });

  it("gives an orphan set to the FIRST rx entry for its exercise", () => {
    const first = rx({ exercise_id: "squat" });
    const other = rx({ exercise_id: "bench", exercise_name: "Bench" });
    const later = rx({ exercise_id: "squat" }); // squat finisher, not first
    const plan = [first, other, later];
    const loose = set({ exercise_id: "squat", prescription_id: null });
    const entries = buildEntries(plan, [], [loose], []);
    const known = new Set(plan.map((r) => r.id));
    const owners = entries.filter(
      (e) => setsForEntry(e, [loose], plan, known).length > 0,
    );
    expect(owners.map((e) => e.key)).toEqual([first.id]);
  });

  it("claims a set pointing at a SINCE-DELETED prescription the same way", () => {
    const plan = [rx({ exercise_id: "squat" })];
    const stale = set({ exercise_id: "squat", prescription_id: "deleted-rx" });
    const known = new Set(plan.map((r) => r.id));
    const entries = buildEntries(plan, [], [stale], []);
    expect(setsForEntry(entries[0], [stale], plan, known)).toEqual([stale]);
  });

  it("synthesizes a fallback entry for an exercise with sets but no rx or extra", () => {
    const plan = [rx({ exercise_id: "squat" })];
    const loose = set({ exercise_id: "cable_fly", prescription_id: null });
    const entries = buildEntries(
      plan,
      [],
      [loose],
      [{ id: "cable_fly", name: "Cable Fly" }],
    );
    expect(entries.map((e) => e.key)).toEqual([plan[0].id, "extra:cable_fly"]);
    expect(entries[1].name).toBe("Cable Fly");
    const known = new Set(plan.map((r) => r.id));
    expect(setsForEntry(entries[1], [loose], plan, known)).toEqual([loose]);
  });

  it("names an unknown fallback exercise from its id rather than dropping it", () => {
    const loose = set({ exercise_id: "some_odd_lift", prescription_id: null });
    const entries = buildEntries([], [], [loose], []);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("some odd lift");
  });

  it("EVERY logged set is visible in exactly one entry", () => {
    const a = rx({ exercise_id: "squat" });
    const b = rx({ exercise_id: "squat" }); // consecutive ramp partner
    const c = rx({ exercise_id: "bench", exercise_name: "Bench" });
    const plan = [a, b, c];
    const sets = [
      set({ exercise_id: "squat", prescription_id: a.id }),
      set({ exercise_id: "squat", prescription_id: b.id }),
      set({ exercise_id: "squat", prescription_id: null }), // orphan
      set({ exercise_id: "bench", prescription_id: "deleted" }), // dangling
      set({ exercise_id: "cable_fly", prescription_id: null }), // no home
    ];
    const entries = buildEntries(plan, [], sets, []);
    const known = new Set(plan.map((r) => r.id));
    const seen = sets.map(
      (s) =>
        entries.filter((e) =>
          setsForEntry(e, sets, plan, known).some((x) => x.id === s.id),
        ).length,
    );
    expect(seen).toEqual([1, 1, 1, 1, 1]);
  });

  it("does not duplicate an entry when an extra is already prescribed", () => {
    const plan = [rx({ exercise_id: "squat" })];
    const entries = buildEntries(
      plan,
      [{ exercise_id: "squat", name: "Back Squat" }],
      [],
      [],
    );
    expect(entries.map((e) => e.exercise_id)).toEqual(["squat"]);
  });

  it("does not synthesize a second entry for an exercise an extra already covers", () => {
    const loose = set({ exercise_id: "cable_fly", prescription_id: null });
    const entries = buildEntries(
      [],
      [{ exercise_id: "cable_fly", name: "Cable Fly" }],
      [loose],
      [],
    );
    expect(entries.map((e) => e.key)).toEqual(["extra:cable_fly"]);
  });
});

// ---- supersets -------------------------------------------------------------

describe("supersetInfo", () => {
  it("tags consecutive members of a real superset A1/A2", () => {
    const a = rx({ exercise_id: "bench", superset_group: 1 });
    const b = rx({ exercise_id: "row", superset_group: 1 });
    const entries = buildEntries([a, b], [], [], []);
    const info = supersetInfo(entries);
    expect(info.get(a.id)).toEqual({ tag: "A1", first: true, last: false });
    expect(info.get(b.id)).toEqual({ tag: "A2", first: false, last: true });
  });

  it("does NOT tag a group with only one member — it has no partner", () => {
    const a = rx({ exercise_id: "bench", superset_group: 1 });
    const b = rx({ exercise_id: "row", superset_group: null });
    const entries = buildEntries([a, b], [], [], []);
    expect(supersetInfo(entries).size).toBe(0);
  });

  it("letters groups from 1 = A", () => {
    expect(supersetLetter(1)).toBe("A");
    expect(supersetLetter(2)).toBe("B");
  });
});

// A superset is done in ROUNDS: after A1 comes A2, after A2 comes A1 again.
// The screen's own "next" only appears once the open exercise is finished,
// which mid-round it never is — so every round used to end in a scroll and a
// tap back up the list.
describe("supersetPartner", () => {
  const a1 = rx({
    exercise_id: "bench",
    exercise_name: "Bench",
    superset_group: 1,
  });
  const a2 = rx({
    exercise_id: "row",
    exercise_name: "Row",
    superset_group: 1,
  });
  const a3 = rx({
    exercise_id: "fly",
    exercise_name: "Fly",
    superset_group: 1,
  });
  const solo = rx({ exercise_id: "squat", superset_group: null });
  const none = () => false;

  it("points at the partner after the open exercise", () => {
    const entries = buildEntries([a1, a2], [], [], []);
    expect(supersetPartner(entries, a1.id, none)?.key).toBe(a2.id);
  });

  it("wraps from the last member back to the first", () => {
    // standing on A2 with A1 still outstanding, the answer is A1 — that is
    // what makes it a round rather than a list
    const entries = buildEntries([a1, a2], [], [], []);
    expect(supersetPartner(entries, a2.id, none)?.key).toBe(a1.id);
  });

  it("skips a partner that is already finished", () => {
    const entries = buildEntries([a1, a2, a3], [], [], []);
    const done = (e: ExerciseEntry) => e.key === a2.id;
    expect(supersetPartner(entries, a1.id, done)?.key).toBe(a3.id);
  });

  it("is null when every other member is done — the round is over", () => {
    const entries = buildEntries([a1, a2], [], [], []);
    const done = (e: ExerciseEntry) => e.key !== a1.id;
    expect(supersetPartner(entries, a1.id, done)).toBeNull();
  });

  it("never points at the open entry itself, even when it is unfinished", () => {
    const entries = buildEntries([a1, a2], [], [], []);
    const done = (e: ExerciseEntry) => e.key === a2.id;
    expect(supersetPartner(entries, a1.id, done)).toBeNull();
  });

  it("is null outside a superset, and for a group of one", () => {
    // same rule supersetInfo uses to withhold the A1 tag: a lone member has
    // nobody to alternate with, and the rail and the hint must agree
    const entries = buildEntries([solo, a1], [], [], []);
    expect(supersetPartner(entries, solo.id, none)).toBeNull();
    expect(supersetPartner(entries, a1.id, none)).toBeNull();
  });

  it("is null with nothing open, or a key no entry carries", () => {
    const entries = buildEntries([a1, a2], [], [], []);
    expect(supersetPartner(entries, null, none)).toBeNull();
    expect(supersetPartner(entries, "gone", none)).toBeNull();
  });

  it("stays inside its own group when two supersets sit side by side", () => {
    const b1 = rx({ exercise_id: "curl", superset_group: 2 });
    const b2 = rx({ exercise_id: "pushdown", superset_group: 2 });
    const entries = buildEntries([a1, a2, b1, b2], [], [], []);
    expect(supersetPartner(entries, a2.id, none)?.key).toBe(a1.id);
    expect(supersetPartner(entries, b1.id, none)?.key).toBe(b2.id);
  });
});

describe("declared schemes for mid-session extras", () => {
  const ex = [{ id: "curl", name: "Hammer Curl" }];

  it("an extra with no scheme has no target, as before", () => {
    const [entry] = buildEntries(
      [],
      [{ exercise_id: "curl", name: "Hammer Curl" }],
      [],
      ex,
    );
    expect(entry!.brackets).toEqual([]);
  });

  it("a declared scheme becomes brackets the session can count against", () => {
    const [entry] = buildEntries(
      [],
      [
        {
          exercise_id: "curl",
          name: "Hammer Curl",
          scheme: [
            {
              sets: 1,
              reps_min: 12,
              reps_max: 12,
              load_kg: 10,
              set_type: "warmup",
              rest_seconds: 60,
            },
            {
              sets: 3,
              reps_min: 8,
              reps_max: 8,
              load_kg: 20,
              set_type: "working",
              rest_seconds: 90,
            },
          ],
        },
      ],
      [],
      ex,
    );
    expect(entry!.brackets).toHaveLength(2);
    // the declared warmup is counted as one, and the target is the three
    // working sets — exactly as a coach's own scheme is read
    expect(workingSets(entry!)).toBe(3);
    expect(warmupSets(entry!)).toBe(1);
    expect(entry!.brackets[0]!.set_type).toBe("warmup");
    expect(entry!.brackets[1]!.resolved_load_kg).toBe(20);
  });

  it("carries the section and tracking mode it was declared with", () => {
    // Both used to be dropped between the add sheet and the entry. Picking
    // "tick only" for a mobility drill mid-session still produced load and
    // reps steppers, because isTick reads brackets[0].tracking — and picking
    // a section filed the exercise nowhere. Anything sayable while planning
    // has to mean the same thing said on the gym floor.
    const [entry] = buildEntries(
      [],
      [
        {
          exercise_id: "curl",
          name: "Hammer Curl",
          scheme: [
            {
              sets: 2,
              reps_min: 10,
              reps_max: 10,
              load_kg: null,
              set_type: "working",
              rest_seconds: 60,
              section: "Activations",
              tracking: "done",
            },
          ],
        },
      ],
      [],
      ex,
    );
    expect(entry!.brackets[0]!.section).toBe("Activations");
    expect(entry!.brackets[0]!.tracking).toBe("done");
  });

  it("defaults an extra declared before those existed to reps, no section", () => {
    // Extras already in the device cache carry neither field.
    const [entry] = buildEntries(
      [],
      [
        {
          exercise_id: "curl",
          name: "Hammer Curl",
          scheme: [
            {
              sets: 3,
              reps_min: 8,
              reps_max: 8,
              load_kg: 20,
              set_type: "working",
              rest_seconds: 90,
            },
          ],
        },
      ],
      [],
      ex,
    );
    expect(entry!.brackets[0]!.tracking).toBe("reps");
    expect(entry!.brackets[0]!.section).toBeNull();
  });

  it("marks its brackets local, so no set links them as a prescription", () => {
    // sets.prescription_id is a foreign key. A synthesized id in it fails the
    // insert, and on the offline queue it fails forever.
    const [entry] = buildEntries(
      [],
      [
        {
          exercise_id: "curl",
          name: "Hammer Curl",
          scheme: [
            {
              sets: 3,
              reps_min: 8,
              reps_max: 8,
              load_kg: 20,
              set_type: "working",
              rest_seconds: 90,
            },
          ],
        },
      ],
      [],
      ex,
    );
    expect(entry!.brackets.every((b) => isLocalBracket(b.id))).toBe(true);
    expect(isLocalBracket("a1b2c3d4-0000-4000-8000-000000000000")).toBe(false);
    expect(isLocalBracket(null)).toBe(false);
  });

  it("a real prescription for the same exercise wins over the extra", () => {
    const rx = [
      {
        id: "rx-1",
        planned_workout_id: "w",
        exercise_id: "curl",
        exercise_name: "Hammer Curl",
        position: 0,
        sets: 3,
        reps_min: 8,
        reps_max: 8,
        rest_seconds: null,
        notes: null,
        load_kg: 25,
        load_pct_tm: null,
        tm_kg: null,
        resolved_load_kg: 25,
        plate_load_kg: 25,
        superset_group: null,
      },
    ] as never;
    const entries = buildEntries(
      rx,
      [
        {
          exercise_id: "curl",
          name: "Hammer Curl",
          scheme: [
            {
              sets: 9,
              reps_min: 1,
              reps_max: 1,
              load_kg: 1,
              set_type: "working",
              rest_seconds: 1,
            },
          ],
        },
      ],
      [],
      ex,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.brackets[0]!.id).toBe("rx-1");
  });
});

describe("a declared scheme still owns the sets logged against it", () => {
  const ex = [{ id: "curl", name: "Hammer Curl" }];
  const extra = {
    exercise_id: "curl",
    name: "Hammer Curl",
    scheme: [
      {
        sets: 4,
        reps_min: 8,
        reps_max: 8,
        load_kg: 20,
        set_type: "working",
        rest_seconds: 90,
      },
    ],
  };
  const set = (id: string) =>
    ({
      id,
      session_id: "s",
      exercise_id: "curl",
      // null on purpose: prescription_id is a foreign key and a declared
      // bracket is not a row in prescriptions
      prescription_id: null,
      set_index: 0,
      set_type: "working",
      load_kg: 20,
      reps: 8,
      performed_at: "2026-08-31T10:00:00Z",
    }) as never;

  it("counts its own sets rather than matching on bracket ids", () => {
    const [entry] = buildEntries([], [extra], [set("a"), set("b")], ex);
    expect(
      setsForEntry(entry!, [set("a"), set("b")], [], new Set()),
    ).toHaveLength(2);
  });

  it("so the target counts down instead of sticking at set 1", () => {
    const [entry] = buildEntries([], [extra], [set("a")], ex);
    const done = setsForEntry(entry!, [set("a")], [], new Set()).length;
    expect(workingSets(entry!)).toBe(4);
    expect(done).toBe(1);
  });
});
