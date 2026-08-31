import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { todayIso } from "../lib/dates.ts";
import {
  guard,
  jsonResult,
  ToolError,
  type RequestContext,
} from "../lib/errors.ts";
import { formatRepRange } from "../lib/format.ts";
import { log } from "../lib/log.ts";

const prescriptionSchema = z
  .object({
    exercise_id: z
      .string()
      .min(1)
      .describe(
        "Exercise id slug. Must exist in the library (use search_exercises).",
      ),
    position: z
      .number()
      .int()
      .min(0)
      .describe("Order within the workout, 0-based. Unique per workout."),
    sets: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of prescribed sets."),
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
    notes: z.string().optional().describe("Coach notes for this prescription."),
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

const workoutSchema = z.object({
  day_index: z
    .number()
    .int()
    .min(0)
    .describe("Day within the program, 0-based. Unique per program."),
  label: z.string().optional().describe("Human label, e.g. 'Day 1 - Squat'."),
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
  name: z.string().min(1).describe("Program name, e.g. 'Block 3 - Strength'."),
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
    const resolved =
      tm != null
        ? ` (~${kgLabel(Math.round((rx.load_pct_tm / 100) * tm * 10) / 10, rx.load_entry)})`
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
        "never touched. Every exercise_id must exist (use search_exercises) and " +
        "every %TM prescription requires a current training max (use " +
        "set_training_max first).",
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
        for (const w of program.workouts) {
          const positions = w.prescriptions.map((p) => p.position);
          if (new Set(positions).size !== positions.length) {
            throw new ToolError(
              `Duplicate prescription positions in workout day_index ${w.day_index}.`,
            );
          }
        }

        // Every exercise_id must exist.
        const allIds = [
          ...new Set(
            program.workouts.flatMap((w) =>
              w.prescriptions.map((p) => p.exercise_id),
            ),
          ),
        ];
        const known = must(
          await db.client.from("exercises").select("id").in("id", allIds),
          "exercise lookup",
        ) as { id: string }[];
        const knownIds = new Set(known.map((e) => e.id));
        const unknown = allIds.filter((id) => !knownIds.has(id));
        if (unknown.length > 0) {
          throw new ToolError(
            `Unknown exercise ids: ${unknown.join(", ")}. ` +
              "Call search_exercises to find the correct id slugs.",
          );
        }

        // Every %TM prescription must be resolvable against a current TM.
        const pctIds = [
          ...new Set(
            program.workouts
              .flatMap((w) => w.prescriptions)
              .filter((p) => p.load_pct_tm != null)
              .map((p) => p.exercise_id),
          ),
        ];
        const tms = new Map<string, number>();
        if (pctIds.length > 0) {
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
          if (missingTm.length > 0) {
            // A future-dated TM exists but is invisible to v_current_tm until
            // its date arrives — say so instead of just "no TM".
            // gte, not gt: the boundary day belongs to the database, which
            // decides currency with its own now() at app_tz(). A row dated
            // exactly today is either already current (so it is not in
            // missingTm and cannot be listed here) or it is one the view has
            // not reached yet — and gt() dropped exactly that row, leaving the
            // "no current training max" error with nothing to explain.
            const futureRows = must(
              await db.client
                .from("training_maxes")
                .select("exercise_id, value_kg, effective_date")
                .eq("user_id", db.ownerId)
                .in("exercise_id", missingTm)
                .gte("effective_date", await todayIso(db))
                .order("effective_date", { ascending: true }),
              "future TM lookup",
            ) as {
              exercise_id: string;
              value_kg: number;
              effective_date: string;
            }[];
            const futureNote =
              futureRows.length > 0
                ? " Note: future-dated TMs exist but are not yet current: " +
                  futureRows
                    .map(
                      (r) =>
                        `${r.exercise_id} (${r.value_kg} kg effective ${r.effective_date})`,
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
            .eq("name", program.name),
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

          const rxRows = program.workouts.flatMap((w) =>
            w.prescriptions.map((p) => ({
              user_id: db.ownerId,
              planned_workout_id: workoutIdByDay.get(w.day_index)!,
              exercise_id: p.exercise_id,
              position: p.position,
              sets: p.sets,
              reps_min: p.reps_min,
              reps_max: p.reps_max,
              load_kg: p.load_kg ?? null,
              load_pct_tm: p.load_pct_tm ?? null,
              rest_seconds: p.rest_seconds ?? null,
              notes: p.notes ?? null,
              superset_group: p.superset_group ?? null,
              load_entry: p.load_entry ?? null,
              // Column default is 'working'; omit rather than write a guess.
              ...(p.set_type === undefined ? {} : { set_type: p.set_type }),
            })),
          );
          const { error: rxError } = await db.client
            .from("prescriptions")
            .insert(rxRows);
          if (rxError)
            throw new Error(`insert prescriptions: ${rxError.message}`);
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
            .delete()
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
          "| Day | Date | Label | # | Exercise | Type | Sets x Reps | Load | Rest |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ];
        for (const w of [...program.workouts].sort(
          (a, b) => a.day_index - b.day_index,
        )) {
          for (const p of [...w.prescriptions].sort(
            (a, b) => a.position - b.position,
          )) {
            lines.push(
              `| ${w.day_index} | ${w.scheduled_date ?? ""} | ${w.label ?? ""} | ${p.position} | ${p.exercise_id} ` +
                `| ${p.set_type ?? "working"} ` +
                `| ${formatRepRange(p.sets, p.reps_min, p.reps_max)} | ${loadLabel(p, tms)} ` +
                `| ${p.rest_seconds != null ? `${p.rest_seconds}s` : ""} |`,
            );
          }
        }
        lines.push(
          "",
          "This program is UNCONFIRMED. Review it with the user; after explicit " +
            `approval in chat, call confirm_program with program_id ${programId}.`,
        );
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
          },
          lines.join("\n"),
        );
      }),
  );
}
