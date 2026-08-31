import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

/**
 * The missing half of upsert_program.
 *
 * Until this existed, the tool surface could WRITE a plan and never read one
 * back. That made every follow-up impossible: "what is she doing Thursday",
 * "add a back-off set to the squat day", "did the coach already program this
 * week" — all of them need the current plan, and the only way to get it was to
 * ask the user to read it off their phone. Worse, editing a day meant
 * upsert_program rewriting a program from memory, which is how prescriptions
 * silently disappear.
 *
 * Read-only. Everything here is scoped to db.ownerId in code, because the MCP
 * server runs as the service role and RLS is not doing it for us.
 */
interface PrescriptionRow {
  id: string;
  position: number;
  exercise_id: string;
  exercise_name: string;
  set_type: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  load_pct_tm: number | null;
  resolved_load_kg: number | null;
  load_entry: string | null;
  rest_seconds: number | null;
  superset_group: number | null;
  notes: string | null;
}

interface WorkoutRow {
  id: string;
  day_index: number;
  label: string | null;
  scheduled_date: string | null;
  notes: string | null;
  plan_note: string | null;
}

export function registerGetProgram(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_program",
    {
      title: "Get program",
      description:
        "The user's current training program: every planned day with its " +
        "prescriptions, in order. Read this BEFORE editing a plan with " +
        "upsert_program — that tool replaces a program wholesale, so writing " +
        "one from memory silently drops whatever you did not remember. " +
        "Prescriptions carry set_type ('warmup' | 'working' | 'backoff'); " +
        "consecutive rows naming the same exercise are one ramp (e.g. a warmup " +
        "build-up into a top set) and the app renders them as a single entry. " +
        "`notes` on a day is the COACH's words from a parse; `plan_note` is " +
        "the user's own and must never be overwritten by a parse.",
      inputSchema: {
        include_unconfirmed: z
          .boolean()
          .default(false)
          .describe(
            "Include programs still awaiting the user's approval " +
              "(confirmed_at IS NULL). Default false: an unconfirmed program " +
              "is a proposal, not the plan.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_program", async () => {
        let q = db.client
          .from("programs")
          .select("id, name, source_note, confirmed_at, created_at")
          .eq("user_id", db.ownerId)
          .is("discarded_at", null)
          .order("created_at", { ascending: false })
          .limit(1);
        if (!args.include_unconfirmed) q = q.not("confirmed_at", "is", null);

        const programs = must(await q, "programs") as unknown as {
          id: string;
          name: string;
          source_note: string | null;
          confirmed_at: string | null;
          created_at: string;
        }[];
        const program = programs[0];
        if (program === undefined) {
          return jsonResult({
            data: { program: null, workouts: [] },
            metadata: {
              note: args.include_unconfirmed
                ? "No program exists yet. upsert_program creates one."
                : "No CONFIRMED program. Retry with include_unconfirmed to " +
                  "see a proposal that is still waiting for approval.",
            },
          });
        }

        const workouts = must(
          await db.client
            // v_plan_workouts excludes saved templates, which are dateless
            // planned days and are not part of the plan.
            .from("v_plan_workouts")
            .select("id, day_index, label, scheduled_date, notes, plan_note")
            .eq("user_id", db.ownerId)
            .eq("program_id", program.id)
            .order("day_index", { ascending: true }),
          "v_plan_workouts",
        ) as unknown as WorkoutRow[];

        const rx =
          workouts.length === 0
            ? []
            : (must(
                await db.client
                  .from("v_resolved_prescriptions")
                  .select(
                    "id, planned_workout_id, position, exercise_id, exercise_name, " +
                      "set_type, sets, reps_min, reps_max, load_kg, load_pct_tm, " +
                      "resolved_load_kg, load_entry, rest_seconds, superset_group, notes",
                  )
                  .eq("user_id", db.ownerId)
                  .in(
                    "planned_workout_id",
                    workouts.map((w) => w.id),
                  )
                  .order("position", { ascending: true }),
                "v_resolved_prescriptions",
              ) as unknown as (PrescriptionRow & {
                planned_workout_id: string;
              })[]);

        const byWorkout = new Map<string, PrescriptionRow[]>();
        for (const r of rx) {
          const { planned_workout_id, ...rest } = r;
          const list = byWorkout.get(planned_workout_id);
          if (list === undefined) byWorkout.set(planned_workout_id, [rest]);
          else list.push(rest);
        }

        return jsonResult({
          data: {
            program: {
              id: program.id,
              name: program.name,
              // Where the program came from — a parsed coach screenshot, the
              // app's own editor. `programs` has no start date; days carry
              // their own scheduled_date.
              source_note: program.source_note,
              created_at: program.created_at,
              confirmed: program.confirmed_at !== null,
            },
            workouts: workouts.map((w) => ({
              ...w,
              prescriptions: byWorkout.get(w.id) ?? [],
            })),
          },
          metadata: {
            workout_count: workouts.length,
            prescription_count: rx.length,
            note:
              "load_kg is always the TOTAL load moved in one rep; load_entry " +
              "records how it was typed ('per_side' means the lifter entered " +
              "the per-hand number and it was doubled). Quote it back the way " +
              "it was entered, not the stored total.",
          },
        });
      }),
  );
}
