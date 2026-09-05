// The prescription — the unit both plan-writing tools share.
//
// `upsert_program` writes a whole program; `update_planned_workout` writes one
// day of an existing one. They validate identically on purpose: an exercise
// that is unknown, or a %TM with no current training max, must fail the same
// way whichever door it came through. Divergence here would mean a program
// could hold a prescription a day-level edit would have refused.

import { z } from "zod";
import type { Db } from "./db.ts";
import { must, visibleExerciseIds } from "./db.ts";
import { todayIso } from "./dates.ts";
import { ToolError } from "./errors.ts";

// NOTE: there is deliberately no `position` field. The ARRAY ORDER is the
// order of the day, and both tools renumber from it. A caller-supplied
// position was a second source of truth that could disagree with the array —
// and adjacency is what encodes ramps, supersets and sections, so a gap or a
// duplicate silently reshapes the workout.
export const prescriptionSchema = z
  .object({
    exercise_id: z
      .string()
      .min(1)
      .describe(
        "Exercise id slug. Must exist in the library (use search_exercises).",
      ),
    sets: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of prescribed sets."),
    section: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "Heading this exercise sits under — 'Activations', 'Abs', " +
          "'Cooldown', or whatever the coach called it. Consecutive " +
          "prescriptions sharing a section render as one titled block, so " +
          "keep them adjacent in `position`. Omit for the main body of the " +
          "workout, which needs no heading. Use the coach's own wording; do " +
          "not invent sections they did not write.",
      ),
    tracking: z
      .enum(["reps", "done"])
      .optional()
      .describe(
        "How it is logged. 'reps' (the default) is weight and reps. 'done' " +
          "is a completion tick, for movements nobody counts — band " +
          "activations, mobility drills, anything the coach wrote without a " +
          "load or a rep target. A 'done' set records reps 0 at load 0 and " +
          "stays out of volume and e1RM.",
      ),
    set_type: z
      .enum(["warmup", "working", "backoff"])
      .optional()
      .describe(
        "What this set-group IS. Defaults to 'working'. Use 'warmup' for the " +
          "coach's explicit warmup or ramp-up sets ('warm up to', 'build to', " +
          "'2 light sets first') and 'backoff' for volume sets after a top " +
          "single ('then 3x5 @80%'). Warmup groups do not count toward the " +
          "day's working-set target. When the coach does not say, leave it " +
          "unset rather than guessing — 'working' is the honest default.",
      ),
    reps_min: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Bottom of the rep range."),
    reps_max: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe(
        "Top of the rep range. Must be >= reps_min. Equal for a fixed rep count.",
      ),
    load_kg: z
      .number()
      .positive()
      .optional()
      .describe("Absolute load in kg. Mutually exclusive with load_pct_tm."),
    load_pct_tm: z
      .number()
      .positive()
      .max(200)
      .optional()
      .describe(
        "Load as a percent of training max (e.g. 72.5). Mutually exclusive with " +
          "load_kg. Requires a current training max for the exercise. Omit both " +
          "load fields when the coach said 'by feel'.",
      ),
    load_entry: z
      .enum(["total", "per_side"])
      .optional()
      .describe(
        "How the load is EXPRESSED. load_kg (and any %TM it resolves to) is " +
          "ALWAYS the TOTAL system load — the whole weight moved in one rep. " +
          "When the coach writes a per-hand number ('DB bench 3x10 @ 30', " +
          "'30s', '30 each'), DOUBLE it into load_kg and set " +
          "load_entry: 'per_side' so the app shows the lifter 30 x 2. Use " +
          "'total' for a barbell, a machine stack, or single-arm work where " +
          "one implement IS the whole system (a one-arm row at 30 kg is " +
          "total 30, not 60). Omit only when the coach's programming genuinely " +
          "does not say — omitted means UNKNOWN, not total.",
      ),
    rest_seconds: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .optional()
      .describe("Prescribed rest between sets, in seconds."),
    notes: z
      .string()
      .max(300)
      .optional()
      .describe(
        "Coach notes for this ONE exercise on this ONE day, brief (a cue, a " +
          "tempo, a caveat). Capped at 300 characters, like the day's notes: " +
          "this renders next to the exercise on a phone mid-set, so an essay " +
          "here buries the sets and reps it is supposed to qualify. Parse " +
          "commentary belongs in chat.",
      ),
    superset_group: z
      .number()
      .int()
      .min(1)
      .max(26)
      .optional()
      .describe(
        "Superset marker: prescriptions in the same workout sharing a group " +
          "number are performed as a superset (1 = A, 2 = B, ...). Use when " +
          "the coach pairs exercises ('A1/A2', 'superset with', arrows).",
      ),
  })
  .refine((p) => !(p.load_kg != null && p.load_pct_tm != null), {
    message: "load_kg and load_pct_tm are mutually exclusive",
  })
  .refine((p) => p.reps_max >= p.reps_min, {
    message: "reps_max must be >= reps_min",
  })
  .refine(
    (p) =>
      p.load_entry !== "per_side" || p.load_kg != null || p.load_pct_tm != null,
    {
      message:
        "load_entry 'per_side' needs a load; a 'by feel' prescription has no " +
        "side to halve",
    },
  );

export type Prescription = z.infer<typeof prescriptionSchema>;

/**
 * A superset is exercises ALTERNATED with each other, so a group of one is not
 * a superset — it is a mis-parse. The schema cannot see it: `superset_group`
 * is validated per prescription, and "is anything else in group A" is a fact
 * about the whole day.
 *
 * It matters because the group is not decoration. The app pairs the members
 * and walks the lifter between them; a lone member renders as an A with
 * nothing to alternate with, and the far more likely truth is that the coach
 * wrote A1/A2 and the second one landed in the wrong day, lost its group, or
 * never got parsed at all. Refusing is how that gets noticed while the
 * screenshot is still on screen.
 *
 * `where` names the day in the message ("day 2", "this day") — a program-wide
 * write reports which day, a single-day edit has only one.
 */
export function assertSupersetGroups(
  prescriptions: Prescription[],
  where: string,
): void {
  const members = new Map<number, string[]>();
  for (const p of prescriptions) {
    if (p.superset_group == null) continue;
    const list = members.get(p.superset_group);
    if (list === undefined) members.set(p.superset_group, [p.exercise_id]);
    else list.push(p.exercise_id);
  }
  const lonely = [...members.entries()]
    .filter(([, list]) => list.length < 2)
    .sort(([a], [b]) => a - b);
  if (lonely.length === 0) return;

  throw new ToolError(
    `On ${where}, ${lonely
      .map(
        ([group, list]) =>
          `superset_group ${String.fromCharCode(64 + group)} has only ` +
          `${list[0]}`,
      )
      .join("; ")}. A superset is two or more exercises alternated, so a ` +
      "group of one is either a mis-parse or a pairing whose other half went " +
      "missing. Add the exercise it pairs with, or drop superset_group from " +
      "it.",
  );
}

/** Every exercise must exist AND be visible to this owner. */
export async function assertExercisesExist(
  db: Db,
  prescriptions: Prescription[],
): Promise<void> {
  const ids = [...new Set(prescriptions.map((p) => p.exercise_id))];
  if (ids.length === 0) return;
  const known = await visibleExerciseIds(db, ids);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ToolError(
      `Unknown exercise ids: ${unknown.join(", ")}. Search the library with ` +
        "search_exercises and use the exact id, or add_exercise it first.",
    );
  }
}

/**
 * Resolve every %TM prescription against a CURRENT training max, or explain
 * precisely why it cannot be. A future-dated TM is invisible to v_current_tm
 * until its date arrives, and saying "no training max" about a TM the user can
 * see in the app is the kind of answer that costs trust.
 */
export async function resolveTrainingMaxes(
  db: Db,
  prescriptions: Prescription[],
): Promise<Map<string, number>> {
  const pctIds = [
    ...new Set(
      prescriptions.filter((p) => p.load_pct_tm != null).map((p) =>
        p.exercise_id
      ),
    ),
  ];
  const tms = new Map<string, number>();
  if (pctIds.length === 0) return tms;

  const tmRows = must(
    await db.client
      .from("v_current_tm")
      .select("exercise_id, value_kg")
      .eq("user_id", db.ownerId)
      .in("exercise_id", pctIds),
    "training max lookup",
  ) as { exercise_id: string; value_kg: number }[];
  for (const row of tmRows) tms.set(row.exercise_id, row.value_kg);

  const missingTm = pctIds.filter((id) => !tms.has(id));
  if (missingTm.length === 0) return tms;

  // gte, not gt: the boundary day belongs to the database, which decides
  // currency with its own now() at app_tz().
  const futureRows = must(
    await db.client
      .from("training_maxes")
      .select("exercise_id, value_kg, effective_date")
      .eq("user_id", db.ownerId)
      .in("exercise_id", missingTm)
      .gte("effective_date", await todayIso(db))
      .order("effective_date", { ascending: true }),
    "future TM lookup",
  ) as { exercise_id: string; value_kg: number; effective_date: string }[];
  const futureNote = futureRows.length > 0
    ? " Note: future-dated TMs exist but are not yet current: " +
      futureRows
        .map((r) =>
          `${r.exercise_id} (${r.value_kg} kg effective ${r.effective_date})`
        )
        .join(", ") +
      "."
    : "";
  throw new ToolError(
    `These exercises use load_pct_tm but have no current training max: ` +
      `${missingTm.join(", ")}. Set one with set_training_max first; ` +
      "%TM programs must be resolvable." +
      futureNote,
  );
}

/** Insert rows for one day. Positions are renumbered from the array order:
 *  the caller's intent is the ORDER they listed, and a hand-written position
 *  gap or duplicate would silently reshape the day. */
export function prescriptionRows(
  ownerId: string,
  plannedWorkoutId: string,
  prescriptions: Prescription[],
): Record<string, unknown>[] {
  return prescriptions.map((p, i) => ({
    user_id: ownerId,
    planned_workout_id: plannedWorkoutId,
    exercise_id: p.exercise_id,
    position: i,
    sets: p.sets,
    reps_min: p.reps_min,
    reps_max: p.reps_max,
    load_kg: p.load_kg ?? null,
    load_pct_tm: p.load_pct_tm ?? null,
    load_entry: p.load_entry ?? null,
    rest_seconds: p.rest_seconds ?? null,
    notes: p.notes ?? null,
    superset_group: p.superset_group ?? null,
    section: p.section ?? null,
    // Column defaults are 'working' and 'reps'; omit rather than write a guess,
    // so "the coach did not say" stays distinguishable in the write path.
    ...(p.set_type === undefined ? {} : { set_type: p.set_type }),
    ...(p.tracking === undefined ? {} : { tracking: p.tracking }),
  }));
}
