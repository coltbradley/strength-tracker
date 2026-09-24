import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  ToolError,
  type RequestContext,
} from "../lib/errors.ts";

/**
 * "What changed, for adapting the next session": planned vs performed, per
 * prescription, plus every set that was not planned and every skip. Not an
 * adherence score — CLAUDE.md's v_weekly_summary ratio ban applies here too.
 *
 * Built from three reads rather than v_adherence alone, because v_adherence
 * only carries the ACTUAL set's set_type (its filter already excludes
 * anything logged as warmup) and never the PRESCRIPTION's exercise_id or
 * set_type — exactly the two facts a swap or a "warmup taken as working"
 * needs. v_live_sets (every set this session, every type) plus the day's
 * prescriptions give the planned side; v_adherence still supplies the
 * load/rep comparison for working and backoff sets, so that math is not
 * duplicated here.
 */

interface SessionRow {
  id: string;
  planned_workout_id: string | null;
}

interface PrescriptionRow {
  id: string;
  exercise_id: string;
  set_type: string;
  reps_min: number;
  reps_max: number;
  entered_load: number | null;
  entered_unit: string | null;
  exercises: { name: string } | { name: string }[] | null;
}

interface LiveSetRow {
  id: string;
  exercise_id: string;
  prescription_id: string | null;
  set_index: number;
  set_type: string;
  load_kg: number;
  reps: number;
  performed_at: string;
  entered_load: number | null;
  entered_unit: string | null;
}

interface AdherenceRow {
  set_id: string;
  prescription_id: string;
  actual_load_kg: number;
  actual_reps: number;
  prescribed_load_kg: number | null;
  load_delta_kg: number | null;
  rep_outcome: string;
  actual_entered_load: number | null;
  actual_entered_unit: string | null;
  prescribed_entered_load: number | null;
  prescribed_entered_unit: string | null;
}

interface SkipRow {
  exercise_id: string;
  prescription_id: string | null;
  scope: string;
  reason: string | null;
}

function exerciseName(e: PrescriptionRow["exercises"]): string | null {
  if (e === null) return null;
  return Array.isArray(e) ? (e[0]?.name ?? null) : e.name;
}

export function registerGetSessionDiff(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_session_diff",
    {
      title: "Get session diff",
      description:
        "What changed between the plan and what actually happened in one " +
        "session: per prescription, whether the exercise was swapped, sets " +
        "taken as working vs warmup, and the load/rep delta; every set " +
        "logged with no prescription (unplanned); and every skip with its " +
        "reason. Frame the output as what changed, for adapting the NEXT " +
        "session — never as a completion score. A session with no planned " +
        "day returns every logged set as unplanned and no prescriptions.",
      inputSchema: {
        session_id: z
          .string()
          .uuid()
          .describe("Session id, from get_recent_sessions."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      guard(ctx, "get_session_diff", async () => {
        const sessions = must(
          await db.client
            .from("sessions")
            .select("id, planned_workout_id")
            .eq("id", args.session_id)
            .eq("user_id", db.ownerId)
            .is("discarded_at", null),
          "session lookup",
        ) as unknown as SessionRow[];
        const session = sessions[0];
        if (session === undefined) {
          throw new ToolError(
            `No session with id ${args.session_id} belongs to this user, or ` +
              "it was discarded. Use get_recent_sessions for a valid id.",
          );
        }

        const [prescriptions, liveSets, adherence, skips] = await Promise.all([
          session.planned_workout_id === null
            ? Promise.resolve([] as PrescriptionRow[])
            : (must(
                await db.client
                  .from("prescriptions")
                  .select(
                    "id, exercise_id, set_type, reps_min, reps_max, entered_load, entered_unit, exercises(name)",
                  )
                  .eq("planned_workout_id", session.planned_workout_id)
                  .eq("user_id", db.ownerId),
                "prescriptions",
              ) as unknown as PrescriptionRow[]),
          must(
            await db.client
              .from("v_live_sets")
              .select(
                "id, exercise_id, prescription_id, set_index, set_type, load_kg, reps, performed_at, entered_load, entered_unit",
              )
              .eq("user_id", db.ownerId)
              .eq("session_id", args.session_id)
              .order("set_index", { ascending: true }),
            "session sets",
          ) as unknown as LiveSetRow[],
          must(
            await db.client
              .from("v_adherence")
              .select(
                "set_id, prescription_id, actual_load_kg, actual_reps, prescribed_load_kg, load_delta_kg, rep_outcome, actual_entered_load, actual_entered_unit, prescribed_entered_load, prescribed_entered_unit",
              )
              .eq("user_id", db.ownerId)
              .eq("session_id", args.session_id),
            "adherence",
          ) as unknown as AdherenceRow[],
          must(
            await db.client
              .from("session_skips")
              .select("exercise_id, prescription_id, scope, reason")
              .eq("user_id", db.ownerId)
              .eq("session_id", args.session_id),
            "skips",
          ) as unknown as SkipRow[],
        ]);

        const setsByPrescription = new Map<string, LiveSetRow[]>();
        const unplannedSets: LiveSetRow[] = [];
        for (const s of liveSets) {
          if (s.prescription_id === null) {
            unplannedSets.push(s);
            continue;
          }
          const list = setsByPrescription.get(s.prescription_id);
          if (list === undefined)
            setsByPrescription.set(s.prescription_id, [s]);
          else list.push(s);
        }
        const adherenceBySet = new Map(
          adherence.map((a) => [a.set_id, a] as const),
        );

        const prescriptionDiffs = prescriptions.map((p) => {
          const actual = setsByPrescription.get(p.id) ?? [];
          const swappedTo = actual.find((s) => s.exercise_id !== p.exercise_id);
          const takenAsWorking =
            p.set_type === "warmup" &&
            actual.some(
              (s) => s.set_type === "working" || s.set_type === "backoff",
            );
          const workingActual = actual.filter(
            (s) => s.set_type === "working" || s.set_type === "backoff",
          );
          const takenAsWarmup =
            p.set_type === "working" &&
            actual.length > 0 &&
            actual.every((s) => s.set_type === "warmup");

          return {
            prescription_id: p.id,
            exercise_id: p.exercise_id,
            exercise_name: exerciseName(p.exercises),
            prescribed_set_type: p.set_type,
            reps_min: p.reps_min,
            reps_max: p.reps_max,
            prescribed_entered_load: p.entered_load,
            prescribed_entered_unit: p.entered_unit,
            performed: actual.length > 0,
            exercise_swapped: swappedTo
              ? { to_exercise_id: swappedTo.exercise_id }
              : null,
            taken_as_working: takenAsWorking,
            taken_as_warmup: takenAsWarmup,
            sets: workingActual.map((s) => {
              const a = adherenceBySet.get(s.id);
              return {
                set_id: s.id,
                load_kg: s.load_kg,
                entered_load: s.entered_load,
                entered_unit: s.entered_unit,
                reps: s.reps,
                prescribed_load_kg: a?.prescribed_load_kg ?? null,
                load_delta_kg: a?.load_delta_kg ?? null,
                rep_outcome: a?.rep_outcome ?? null,
                actual_entered_load: a?.actual_entered_load ?? s.entered_load,
                actual_entered_unit: a?.actual_entered_unit ?? s.entered_unit,
                prescribed_entered_load: a?.prescribed_entered_load ?? p.entered_load,
                prescribed_entered_unit: a?.prescribed_entered_unit ?? p.entered_unit,
              };
            }),
          };
        });

        return jsonResult({
          data: {
            session_id: args.session_id,
            had_plan: session.planned_workout_id !== null,
            prescriptions: prescriptionDiffs,
            unplanned_sets: unplannedSets.map((s) => ({
              set_id: s.id,
              exercise_id: s.exercise_id,
              set_type: s.set_type,
              load_kg: s.load_kg,
              entered_load: s.entered_load,
              entered_unit: s.entered_unit,
              reps: s.reps,
            })),
            skips,
          },
          metadata: {
            note:
              "What changed, for adapting the next session — never a " +
              "completion score. A skip or a swap is information, not a " +
              "shortfall.",
          },
        });
      }),
  );
}
