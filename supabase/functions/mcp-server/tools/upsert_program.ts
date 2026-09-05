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
    .describe("Day within the program, 0-based. Unique per program."),
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
        "the percentage into prose.",
      inputSchema: {
        program: programSchema.describe("The full program to write."),
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
              `| ${w.day_index} | ${w.scheduled_date ?? ""} | ${
                w.label ?? ""
              } ` +
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
