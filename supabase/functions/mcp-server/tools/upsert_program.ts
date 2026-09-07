import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  type RequestContext,
  ToolError,
} from "../lib/errors.ts";
import { formatRepRange } from "../lib/format.ts";
import { log } from "../lib/log.ts";
import { assertIsoDate } from "../lib/dates.ts";
import {
  assertExercisesExist,
  assertSupersetGroups,
  prescriptionRows,
  prescriptionSchema,
  resolveTrainingMaxes,
} from "../lib/prescriptions.ts";

const workoutSchema = z.object({
  day_index: z
    .number()
    .int()
    .min(0)
    .describe(
      "Day within the program, 0-based. Unique per program. When the write " +
        "ADDS days to a phase's existing program (see phase_id), these are " +
        "offset past the program's last day and the result reports the map.",
    ),
  label: z
    .string()
    .min(1)
    .max(60)
    .describe("Human label, e.g. 'Day 1 - Squat'.")
    .optional(),
  notes: z
    .string()
    .max(300)
    .optional()
    .describe(
      "The coach's OWN words for the day, brief (cues, intent). This renders " +
        "prominently on the user's phone mid-workout — do NOT store parse " +
        "caveats, omission lists, or assumptions here; report those in chat " +
        "instead.",
    ),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Calendar date (YYYY-MM-DD) this workout is planned for. The app only " +
        "lets the user START a workout on its scheduled date, so set real " +
        "dates when the user says which days they train. Omit when unknown — " +
        "the user can schedule and move days in the app.",
    ),
  prescriptions: z
    .array(prescriptionSchema)
    .min(1)
    .describe("Ordered prescriptions for this day."),
});

const programSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Program name, e.g. 'Block 3 - Strength'. Short: it is the handle the " +
        "user and every other tool refer to this program by, and it is what " +
        "upsert_program matches on when replacing an unconfirmed draft.",
    ),
  source_note: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Provenance in a few words, e.g. 'coach screenshot 2026-08-25'. Not " +
        "shown in the app's main flow — keep parse commentary out of it.",
    ),
  workouts: z
    .array(workoutSchema)
    .min(1)
    .describe("The program's training days."),
});

type Program = z.infer<typeof programSchema>;

// Loads are stored as totals; the summary echoes the per-side number too, so
// the user reviewing the parse sees the figure their coach actually wrote.
function kgLabel(
  totalKg: number,
  entry: "total" | "per_side" | undefined,
): string {
  if (entry !== "per_side") return `${totalKg} kg`;
  return `${Math.round((totalKg / 2) * 10) / 10} kg x 2 (${totalKg} kg total)`;
}

function loadLabel(
  rx: Program["workouts"][number]["prescriptions"][number],
  tms: Map<string, number>,
): string {
  if (rx.load_kg != null) return kgLabel(rx.load_kg, rx.load_entry);
  if (rx.load_pct_tm != null) {
    const tm = tms.get(rx.exercise_id);
    const resolved = tm != null
      ? ` (~${
        kgLabel(
          Math.round((rx.load_pct_tm / 100) * tm * 10) / 10,
          rx.load_entry,
        )
      })`
      : "";
    return `${rx.load_pct_tm}% TM${resolved}`;
  }
  return "by feel";
}

/** The review table. `dayIndexOf` is identity for a new program and the
 *  offset map when days were added to an existing one, so the table shows
 *  the indexes that were actually written. */
function summaryTable(
  program: Program,
  tms: Map<string, number>,
  dayIndexOf: (w: Program["workouts"][number]) => number,
): string[] {
  const lines = [
    "| Day | Date | Label | Section | # | Exercise | SS | Type | Sets x Reps | Load | Rest |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (
    const w of [...program.workouts].sort(
      (a, b) => a.day_index - b.day_index,
    )
  ) {
    // Array order IS the order written, so the review table shows it
    // rather than re-sorting by a field that no longer exists.
    for (const [position, p] of w.prescriptions.entries()) {
      lines.push(
        `| ${dayIndexOf(w)} | ${w.scheduled_date ?? ""} | ${w.label ?? ""} ` +
          `| ${p.section ?? ""} | ${position} | ${p.exercise_id} ` +
          // The superset group is the thing most worth catching in
          // review: a mis-parsed A1/A2 pairing changes how the session is
          // actually performed, and it was written but never shown back.
          `| ${
            p.superset_group == null
              ? ""
              : String.fromCharCode(64 + p.superset_group)
          } ` +
          `| ${p.set_type ?? "working"} ` +
          `| ${
            p.tracking === "done"
              ? "tick"
              : formatRepRange(p.sets, p.reps_min, p.reps_max)
          } ` +
          `| ${p.tracking === "done" ? "" : loadLabel(p, tms)} ` +
          `| ${p.rest_seconds != null ? `${p.rest_seconds}s` : ""} |`,
      );
    }
  }
  return lines;
}

interface PhaseLookupRow {
  id: string;
  name: string;
  training_plans:
    | { id: string; confirmed_at: string | null; superseded_at: string | null }
    | { id: string; confirmed_at: string | null; superseded_at: string | null }[]
    | null;
}

export function registerUpsertProgram(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "upsert_program",
    {
      title: "Upsert program",
      description:
        "Write a training program (workouts + prescriptions) parsed from coach " +
        "programming. All loads are kg and are TOTAL system loads: a per-hand " +
        "dumbbell number must be doubled into load_kg with load_entry " +
        "'per_side' (see that field). The program lands UNCONFIRMED and is not " +
        "used by the app until confirm_program is called after the user approves " +
        "it in chat. If an unconfirmed program with the same name already exists " +
        "it is replaced (safe to iterate on a parse); confirmed programs are " +
        "never touched. Every exercise_id must exist (use search_exercises). " +
        "A %TM prescription with no current training max is written as " +
        "written and listed under unresolved_pct in the result: propose the " +
        "TM from the first session with set_training_max rather than turning " +
        "the percentage into prose.\n\n" +
        "When the user has a training plan (get_training_plan), pass the " +
        "current phase's id as phase_id. If a live program is already filed " +
        "under that phase, the days are ADDED to it instead of a second " +
        "program being created — one program per phase, not one per " +
        "screenshot. Adding days to a CONFIRMED program is live on the " +
        "calendar at once and needs confirm_change=true after the user's " +
        "approval in chat, like editing a day.",
      inputSchema: {
        program: programSchema.describe("The full program to write."),
        phase_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "The plan phase this program belongs to, from get_training_plan " +
              "(the context block names the current one). With it, days join " +
              "the phase's existing live program when there is one; without " +
              "it, a new program is created and filed under nothing.",
          ),
        confirm_change: z
          .boolean()
          .default(false)
          .describe(
            "Only consulted when phase_id names a phase whose live program " +
              "is CONFIRMED: adding days to it changes the user's calendar " +
              "immediately. Set it only after the user approved these " +
              "specific days in chat, in their own words.",
          ),
      },
    },
    (args) =>
      guard(ctx, "upsert_program", async () => {
        const program = args.program;

        // Structural checks the DB would otherwise reject with an opaque 500.
        const dayIndexes = program.workouts.map((w) => w.day_index);
        if (new Set(dayIndexes).size !== dayIndexes.length) {
          throw new ToolError(
            "Duplicate day_index values in program.workouts.",
          );
        }
        // A regex proves SHAPE, not that the date exists: 2026-02-30 and
        // 2026-13-01 both match ^\d{4}-\d{2}-\d{2}$ and then arrive at
        // Postgres as an opaque date-out-of-range error, which the guard turns
        // into "Unexpected server error" — a generic 500 for what is really a
        // typo the model could fix on the next call. assertIsoDate names the
        // parameter and the value.
        for (const [i, w] of program.workouts.entries()) {
          if (w.scheduled_date !== undefined) {
            assertIsoDate(
              w.scheduled_date,
              `program.workouts[${i}].scheduled_date`,
            );
          }
        }

        // A superset group with one member is a pairing that lost its other
        // half somewhere in the parse. Checked per day, because that is the
        // scope the group has.
        for (const w of program.workouts) {
          assertSupersetGroups(w.prescriptions, `day ${w.day_index}`);
        }

        // Every exercise_id must exist AND be one this caller can see.
        //
        // This ran as a bare existence check, and the service role bypasses
        // RLS, so another account's custom exercise passed it, was written
        // into the program, and came back out of get_program by name. Slugs
        // are derived from names, so they are guessable rather than secret.
        // Both validations are shared with update_planned_workout, so an
        // exercise or a %TM that fails here fails there identically.
        const allRx = program.workouts.flatMap((w) => w.prescriptions);
        await assertExercisesExist(db, allRx);
        const tmRes = await resolveTrainingMaxes(db, allRx);
        const tms = tmRes.tms;

        // The phase, when given, must be this user's and on the LIVE plan. A
        // phase of a superseded plan is history; filing new days under it
        // would hide them from get_training_plan, which reads the live plan.
        let phase: { id: string; name: string; plan_confirmed: boolean } | null =
          null;
        // The program already filed under that phase, if any: the write adds
        // days to it rather than creating a second one.
        let target: { id: string; name: string; confirmed_at: string | null } | null =
          null;
        let filedCount = 0;
        if (args.phase_id !== undefined) {
          const rows = must(
            await db.client
              .from("plan_phases")
              .select("id, name, training_plans!inner(id, confirmed_at, superseded_at)")
              .eq("user_id", db.ownerId)
              .eq("id", args.phase_id),
            "phase lookup",
          ) as unknown as PhaseLookupRow[];
          if (rows.length === 0) {
            throw new ToolError(
              `No plan phase with id ${args.phase_id} belongs to this user. ` +
                "Call get_training_plan for the current phase ids.",
            );
          }
          const row = rows[0];
          const plan = Array.isArray(row.training_plans)
            ? row.training_plans[0]
            : row.training_plans;
          if (!plan) {
            throw new ToolError(`Phase ${row.id} has no plan. Nothing to file under.`);
          }
          if (plan.superseded_at !== null) {
            throw new ToolError(
              `Phase "${row.name}" (${row.id}) belongs to a plan superseded on ` +
                `${plan.superseded_at}. Call get_training_plan for the live ` +
                "plan's phase ids and file under one of those.",
            );
          }
          phase = { id: row.id, name: row.name, plan_confirmed: plan.confirmed_at !== null };

          const filed = must(
            await db.client
              .from("programs")
              .select("id, name, confirmed_at")
              .eq("user_id", db.ownerId)
              .eq("phase_id", row.id)
              .is("discarded_at", null)
              .order("created_at", { ascending: false }),
            "programs by phase",
          ) as { id: string; name: string; confirmed_at: string | null }[];
          filedCount = filed.length;
          if (filed.length > 0) {
            target = filed[0];
            if (target.confirmed_at !== null && !args.confirm_change) {
              throw new ToolError(
                `Phase "${row.name}" already has a live program, ` +
                  `'${target.name}' (${target.id}), and it is CONFIRMED — the ` +
                  "plan the user is following, so days added to it land on " +
                  "their calendar the moment they are written. Show them the " +
                  "days you intend to add, get their approval in chat, then " +
                  "retry with confirm_change=true. To change a day that is " +
                  "already there, use update_planned_workout instead.",
              );
            }
          }
        }

        if (target !== null && phase !== null) {
          return await addDaysToProgram(db, ctx, program, tms, phase, target, filedCount);
        }

        // Upsert semantics: replace an UNCONFIRMED program with the same name.
        // Confirmed programs are never touched. The old program is deleted only
        // AFTER the new one is fully written: a failed re-parse must never
        // destroy the previous good parse.
        const existing = must(
          await db.client
            .from("programs")
            .select("id, confirmed_at")
            .eq("user_id", db.ownerId)
            .eq("name", program.name)
            // A discarded program of the same name is already out of the plan;
            // it must neither block the write as a "confirmed same name" nor
            // be counted as something this call replaced.
            .is("discarded_at", null),
          "existing program lookup",
        ) as { id: string; confirmed_at: string | null }[];
        const oldUnconfirmedIds = existing
          .filter((p) => p.confirmed_at === null)
          .map((p) => p.id);
        const confirmedSameName = existing.length - oldUnconfirmedIds.length;

        // Insert program, then workouts, then prescriptions. PostgREST has no
        // transactions; on failure past the program insert, delete the NEW
        // program (cascade cleans up children) so no half-written program is
        // left — the old unconfirmed program is still intact at that point.
        const inserted = must(
          await db.client
            .from("programs")
            .insert({
              user_id: db.ownerId,
              name: program.name,
              source_note: program.source_note ?? null,
              confirmed_at: null,
              phase_id: phase?.id ?? null,
            })
            .select("id")
            .single(),
          "insert program",
        ) as { id: string };
        const programId = inserted.id;

        try {
          const workoutRows = must(
            await db.client
              .from("planned_workouts")
              .insert(
                program.workouts.map((w) => ({
                  user_id: db.ownerId,
                  program_id: programId,
                  day_index: w.day_index,
                  label: w.label ?? null,
                  notes: w.notes ?? null,
                  scheduled_date: w.scheduled_date ?? null,
                })),
              )
              .select("id, day_index"),
            "insert workouts",
          ) as { id: string; day_index: number }[];
          const workoutIdByDay = new Map(
            workoutRows.map((w) => [w.day_index, w.id]),
          );

          // Same row builder update_planned_workout uses: order comes from
          // the array, not from a caller-supplied position.
          const rxRows = program.workouts.flatMap((w) =>
            prescriptionRows(
              db.ownerId,
              workoutIdByDay.get(w.day_index)!,
              w.prescriptions,
            )
          );
          const { error: rxError } = await db.client
            .from("prescriptions")
            .insert(rxRows);
          if (rxError) {
            throw new Error(`insert prescriptions: ${rxError.message}`);
          }
        } catch (err) {
          // Compensating delete. If it fails, a half-written program (program
          // row, maybe workouts, no prescriptions) survives in Postgres and
          // the caller only ever sees the original error — so log it rather
          // than discard it. The next upsert_program with the same name
          // retires the fragment via the unconfirmed-replacement path below.
          const { error: rollbackError } = await db.client
            .from("programs")
            .delete()
            .eq("id", programId);
          if (rollbackError) {
            log("error", "upsert_program_cleanup_failed", {
              request_id: ctx.requestId,
              tool: "upsert_program",
              program_id: programId,
              program_name: program.name,
              error: rollbackError.message,
            });
          }
          throw err;
        }

        // New program fully written: now retire the old unconfirmed one(s).
        // If this cleanup fails the write still succeeded — warn, don't fail.
        let staleWarning: string | null = null;
        if (oldUnconfirmedIds.length > 0) {
          const { error: cleanupError } = await db.client
            .from("programs")
            // Soft, like delete_program: a superseded draft is still something
            // the model wrote, and nothing it writes should be unrecoverable.
            .update({ discarded_at: new Date().toISOString() })
            .eq("user_id", db.ownerId)
            .in("id", oldUnconfirmedIds)
            .is("confirmed_at", null);
          if (cleanupError) {
            staleWarning =
              `The new program was written, but deleting the old unconfirmed ` +
              `program(s) failed: ${oldUnconfirmedIds.join(", ")}. ` +
              `They are now stale duplicates of '${program.name}'.`;
          }
        }

        // Markdown summary of what was written.
        const lines = [
          `## Program written: ${program.name}`,
          "",
          ...summaryTable(program, tms, (w) => w.day_index),
        ];
        if (phase !== null) {
          lines.push(
            "",
            `Filed under plan phase "${phase.name}"` +
              (phase.plan_confirmed
                ? "."
                : " — note that the plan itself is not confirmed yet."),
          );
        }
        lines.push(
          "",
          "This program is UNCONFIRMED. Review it with the user; after explicit " +
            `approval in chat, call confirm_program with program_id ${programId}.`,
        );
        if (tmRes.note !== null) {
          lines.push("", `Unresolved %TM: ${tmRes.note}`);
        }
        if (confirmedSameName > 0) {
          lines.push(
            "",
            `Note: ${confirmedSameName} CONFIRMED program(s) named '${program.name}' ` +
              "already exist and were left untouched.",
          );
        }
        if (staleWarning) {
          lines.push("", `Warning: ${staleWarning}`);
        }

        return jsonResult(
          {
            program_id: programId,
            name: program.name,
            confirmed: false,
            added_to_existing: false,
            phase: phase === null ? null : { id: phase.id, name: phase.name },
            replaced_unconfirmed: staleWarning ? 0 : oldUnconfirmedIds.length,
            ...(staleWarning
              ? {
                warning: staleWarning,
                stale_unconfirmed_program_ids: oldUnconfirmedIds,
              }
              : {}),
            workouts: program.workouts.length,
            prescriptions: program.workouts.reduce(
              (n, w) => n + w.prescriptions.length,
              0,
            ),
            unresolved_pct: tmRes.unresolved_pct,
            ...(tmRes.note === null ? {} : { unresolved_pct_note: tmRes.note }),
          },
          lines.join("\n"),
        );
      }),
  );
}

/**
 * The "add these days to it" path. Same shape as update_planned_workout, one
 * level up: the unit is the program, and what changes is that it grows.
 *
 * day_index continues from the program's last day, counted over EVERY row of
 * the program — templates and discarded days included — because
 * (program_id, day_index) is unique across all of them and a collision here
 * would be an opaque 500. The caller's indexes are offset, not replaced, so a
 * parse that numbered its days 0 and 2 keeps that gap. Failure past the day
 * insert deletes the new days (nobody has seen them; nothing can have been
 * logged against them, so the prescriptions trigger has nothing to refuse) and
 * leaves the program exactly as it was.
 */
async function addDaysToProgram(
  db: Db,
  ctx: RequestContext,
  program: Program,
  tms: Map<string, number>,
  phase: { id: string; name: string; plan_confirmed: boolean },
  target: { id: string; name: string; confirmed_at: string | null },
  filedCount: number,
) {
  const existingDays = must(
    await db.client
      .from("planned_workouts")
      .select("day_index")
      .eq("user_id", db.ownerId)
      .eq("program_id", target.id),
    "existing days",
  ) as { day_index: number }[];
  const base = existingDays.length === 0
    ? 0
    : Math.max(...existingDays.map((d) => d.day_index)) + 1;
  const indexOf = (w: Program["workouts"][number]) => base + w.day_index;

  const workoutRows = must(
    await db.client
      .from("planned_workouts")
      .insert(
        program.workouts.map((w) => ({
          user_id: db.ownerId,
          program_id: target.id,
          day_index: indexOf(w),
          label: w.label ?? null,
          notes: w.notes ?? null,
          scheduled_date: w.scheduled_date ?? null,
        })),
      )
      .select("id, day_index"),
    "insert workouts",
  ) as { id: string; day_index: number }[];
  const workoutIdByDay = new Map(workoutRows.map((w) => [w.day_index, w.id]));

  try {
    const rxRows = program.workouts.flatMap((w) =>
      prescriptionRows(db.ownerId, workoutIdByDay.get(indexOf(w))!, w.prescriptions)
    );
    const { error } = await db.client.from("prescriptions").insert(rxRows);
    if (error) throw new Error(`insert prescriptions: ${error.message}`);
  } catch (err) {
    const { error: rollbackError } = await db.client
      .from("planned_workouts")
      .delete()
      .eq("user_id", db.ownerId)
      .in("id", workoutRows.map((w) => w.id));
    if (rollbackError) {
      log("error", "upsert_program_add_days_cleanup_failed", {
        request_id: ctx.requestId,
        tool: "upsert_program",
        program_id: target.id,
        planned_workout_ids: workoutRows.map((w) => w.id),
        error: rollbackError.message,
      });
    }
    throw err;
  }

  const confirmed = target.confirmed_at !== null;
  const lines = [
    `## Days added to: ${target.name}`,
    "",
    `Filed under plan phase "${phase.name}", which already had this program, ` +
    `so the ${program.workouts.length} day(s) were ADDED to it rather than ` +
    "written as a new program. The name you passed " +
    `('${program.name}') was not used; the program keeps its own.`,
    "",
    ...summaryTable(program, tms, indexOf),
    "",
    confirmed
      ? "The program is CONFIRMED, so these days are live on the user's " +
        "calendar now. No confirm step."
      : "The program is not confirmed yet, so nothing changed on the user's " +
        "calendar. confirm_program makes the whole program live, these days " +
        "included.",
  ];
  if (filedCount > 1) {
    lines.push(
      "",
      `Note: ${filedCount} live programs are filed under this phase; the ` +
        "days went to the newest. list_programs shows them all.",
    );
  }

  return jsonResult(
    {
      program_id: target.id,
      name: target.name,
      confirmed,
      added_to_existing: true,
      phase: { id: phase.id, name: phase.name },
      workouts_added: program.workouts.length,
      day_index_map: program.workouts.map((w) => ({
        given: w.day_index,
        written: indexOf(w),
        planned_workout_id: workoutIdByDay.get(indexOf(w)),
      })),
      prescriptions: program.workouts.reduce((n, w) => n + w.prescriptions.length, 0),
    },
    lines.join("\n"),
  );
}
