// Clone a planned day forward, carrying what was learned.
//
// The third door into the plan, beside upsert_program (a whole new program)
// and update_planned_workout (edit one day). It exists because the common case
// for a coached lifter is neither: the coach sends the same day again, and the
// right write is "that day, on this date, with what I actually lifted last
// time". Without it the model wrote a fresh program per screenshot and every
// number the previous session produced stayed behind.
//
// Three adjustments, each one MADE and SAID in the result:
//  1. Loads logged last time replace the planned loads, by the same ramp-
//     preserving rule the app's saved-workout apply uses (lib/loop.ts).
//  2. Entries follow the order the exercises were actually performed in, with
//     ramps and sections kept whole.
//  3. Set notes that read as instructions ("could be more, maybe 70?") come
//     back as notes_to_consider for the coach to act on. They are not copied:
//     a note to next time belongs to the person writing next time, not on the
//     phone mid-set.
//
// Same program, day_index max+1. A template is refused (it has no "last time"
// and is applied from the app). Nothing here writes sets or sessions.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { assertIsoDate } from "../lib/dates.ts";
import {
  guard,
  jsonResult,
  type RequestContext,
  ToolError,
} from "../lib/errors.ts";
import { lastTimeFor } from "../lib/lastTime.ts";
import { log } from "../lib/log.ts";
import {
  entryOrder,
  firstPerformedAt,
  lastWorkingLoads,
  refreshedLoads,
  reorderByPerformed,
  type RxRow,
} from "../lib/loop.ts";
import {
  assertExercisesExist,
  type Prescription,
  prescriptionRows,
  resolveTrainingMaxes,
} from "../lib/prescriptions.ts";

interface DayRow {
  id: string;
  label: string | null;
  notes: string | null;
  scheduled_date: string | null;
  is_template: boolean;
  programs: { id: string; name: string; confirmed_at: string | null } | null;
}

/** A prescription row back into the shape the shared row builder takes. */
function toPrescription(r: RxRow): Prescription {
  return {
    exercise_id: r.exercise_id,
    sets: r.sets,
    reps_min: r.reps_min,
    reps_max: r.reps_max,
    ...(r.load_kg === null ? {} : { load_kg: r.load_kg }),
    ...(r.load_pct_tm === null ? {} : { load_pct_tm: r.load_pct_tm }),
    ...(r.load_entry === null ? {} : { load_entry: r.load_entry }),
    ...(r.rest_seconds === null ? {} : { rest_seconds: r.rest_seconds }),
    ...(r.notes === null ? {} : { notes: r.notes }),
    ...(r.superset_group === null ? {} : { superset_group: r.superset_group }),
    ...(r.section === null ? {} : { section: r.section }),
    set_type: r.set_type,
    tracking: r.tracking,
  };
}

export function registerRepeatPlannedWorkout(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "repeat_planned_workout",
    {
      title: "Repeat a planned day on a new date",
      description:
        "Schedule a day the user already has AGAIN, on a new date, in the " +
        "same program: the prescriptions are copied with three adjustments, " +
        "all reported in the result. (1) Where an exercise was logged last " +
        "time this day was trained, its planned load becomes the last working " +
        "load — a warmup ramp is rescaled to keep its shape, %TM rows are left " +
        "on their percentage. (2) Exercises are ordered the way they were " +
        "actually performed last time, ramps and sections kept whole. (3) Set " +
        "notes from last time that read as instructions ('could be more, " +
        "maybe 70?') are returned as notes_to_consider, not copied: act on " +
        "them with update_planned_workout or ask. Use this after " +
        "find_similar_days recognises a day, instead of writing a second " +
        "program. Refuses a saved template (apply those in the app). On a " +
        "CONFIRMED program the new day is live on the user's calendar " +
        "immediately, so it needs confirm_change=true after their approval in " +
        "chat.",
      inputSchema: {
        planned_workout_id: z
          .string()
          .uuid()
          .describe(
            "The day to repeat, from find_similar_days or get_program.",
          ),
        scheduled_date: z
          .string()
          .describe(
            "The new date, YYYY-MM-DD in the user's own timezone.",
          ),
        confirm_change: z
          .boolean()
          .default(false)
          .describe(
            "Must be true when the program is CONFIRMED. Set it only after " +
              "the user approved this repeat, on this date, in chat.",
          ),
      },
    },
    (args) =>
      guard(ctx, "repeat_planned_workout", async () => {
        assertIsoDate(args.scheduled_date, "scheduled_date");

        const days = must(
          await db.client
            .from("planned_workouts")
            .select(
              "id, label, notes, scheduled_date, is_template, programs!inner(id, name, confirmed_at)",
            )
            .eq("user_id", db.ownerId)
            .eq("id", args.planned_workout_id)
            .is("discarded_at", null)
            .is("programs.discarded_at", null),
          "planned day lookup",
        ) as unknown as DayRow[];
        if (days.length === 0) {
          throw new ToolError(
            `No planned day with id ${args.planned_workout_id}. It may have ` +
              "been deleted, or belong to a discarded program. Call " +
              "find_similar_days or get_program for the current day ids.",
          );
        }
        const day = days[0];
        const program = Array.isArray(day.programs)
          ? day.programs[0]
          : day.programs;
        if (!program) {
          throw new ToolError(
            `Planned day ${day.id} has no live program. Nothing to repeat.`,
          );
        }
        if (day.is_template) {
          throw new ToolError(
            "This day is a saved TEMPLATE. A template has no 'last time' to " +
              "carry forward and is applied to a date from the app; repeat a " +
              "dated day instead.",
          );
        }
        if (program.confirmed_at !== null && !args.confirm_change) {
          throw new ToolError(
            `'${program.name}' is CONFIRMED, so the repeated day would be ` +
              "live on the user's calendar the moment it lands. Tell them " +
              "which day, which date and what changes (loads, order), get " +
              "their approval in chat, then retry with confirm_change=true.",
          );
        }

        const rows = must(
          await db.client
            .from("prescriptions")
            .select(
              "exercise_id, position, sets, reps_min, reps_max, load_kg, " +
                "load_pct_tm, load_entry, rest_seconds, notes, superset_group, " +
                "section, set_type, tracking",
            )
            .eq("user_id", db.ownerId)
            .eq("planned_workout_id", day.id)
            .order("position", { ascending: true }),
          "prescriptions",
        ) as unknown as RxRow[];
        if (rows.length === 0) {
          throw new ToolError(
            `Planned day ${day.id} has no exercises — it is a draft. There ` +
              "is nothing to repeat; fill it with update_planned_workout, or " +
              "repeat a day that has been trained.",
          );
        }

        // Last time: sets, order, notes. Absent when the day was never
        // trained, in which case the copy is exact and the result says so.
        const { byDay } = await lastTimeFor(db, [day.id]);
        const last = byDay.get(day.id) ?? null;

        // 2. order, then 1. loads. Both operate on entries (ramps), so the
        // order of the two steps does not change the numbers.
        const reordered = last === null
          ? { rows, changed: false }
          : reorderByPerformed(rows, firstPerformedAt(last.sets));
        const lastLoads = last === null
          ? new Map<string, number>()
          : lastWorkingLoads(last.sets);
        const newLoads = refreshedLoads(reordered.rows, lastLoads);
        const loadsReplaced: {
          exercise_id: string;
          position: number;
          from_kg: number | null;
          to_kg: number;
        }[] = [];
        const finalRows: RxRow[] = reordered.rows.map((r, i) => {
          const kg = newLoads[i];
          if (kg === null || kg === r.load_kg) return r;
          loadsReplaced.push({
            exercise_id: r.exercise_id,
            position: i,
            from_kg: r.load_kg,
            to_kg: kg,
          });
          return { ...r, load_kg: kg };
        });

        const prescriptions = finalRows.map(toPrescription);
        // The same gates as the other two doors. A day that was writable once
        // is almost always still writable, but "almost" is not a reason to
        // skip the check that makes the three tools agree.
        await assertExercisesExist(db, prescriptions);
        const tmRes = await resolveTrainingMaxes(db, prescriptions);

        // day_index continues from the program's highest, counting templates
        // and discarded days too: the unique constraint does.
        const top = must(
          await db.client
            .from("planned_workouts")
            .select("day_index")
            .eq("user_id", db.ownerId)
            .eq("program_id", program.id)
            .order("day_index", { ascending: false })
            .limit(1),
          "day index",
        ) as { day_index: number }[];
        const dayIndex = (top[0]?.day_index ?? -1) + 1;

        // plan_note is deliberately NOT copied: it is the user's own note about
        // THAT day, and the new one starts blank for them to write.
        const inserted = must(
          await db.client
            .from("planned_workouts")
            .insert({
              user_id: db.ownerId,
              program_id: program.id,
              day_index: dayIndex,
              label: day.label,
              notes: day.notes,
              scheduled_date: args.scheduled_date,
            })
            .select("id")
            .single(),
          "insert day",
        ) as { id: string };
        const newId = inserted.id;

        const { error: rxError } = await db.client
          .from("prescriptions")
          .insert(prescriptionRows(db.ownerId, newId, prescriptions));
        if (rxError) {
          // No transactions over PostgREST. An empty dated day would read as
          // a DRAFT on the calendar, so it is soft-deleted the way every other
          // planned day is — visible in Postgres, gone from every view.
          const { error: undoError } = await db.client
            .from("planned_workouts")
            .update({ discarded_at: new Date().toISOString() })
            .eq("user_id", db.ownerId)
            .eq("id", newId);
          if (undoError) {
            log("error", "repeat_planned_workout_cleanup_failed", {
              request_id: ctx.requestId,
              tool: "repeat_planned_workout",
              planned_workout_id: newId,
              error: undoError.message,
            });
          }
          throw new Error(`insert prescriptions: ${rxError.message}`);
        }

        const plannedOrder = entryOrder(rows);
        const newOrder = entryOrder(finalRows);
        return jsonResult({
          repeated: true,
          from: {
            planned_workout_id: day.id,
            label: day.label,
            scheduled_date: day.scheduled_date,
            last_trained: last?.session.started_at ?? null,
          },
          planned_workout_id: newId,
          scheduled_date: args.scheduled_date,
          day_index: dayIndex,
          label: day.label,
          program: {
            id: program.id,
            name: program.name,
            confirmed: program.confirmed_at !== null,
          },
          adjustments: {
            loads_replaced: loadsReplaced,
            order_changed: reordered.changed,
            order_was: plannedOrder,
            order_now: newOrder,
            notes_not_copied: last?.notes_to_consider.length ?? 0,
          },
          notes_to_consider: last?.notes_to_consider ?? [],
          other_set_notes_last_time: last?.other_notes ?? [],
          unresolved_pct: tmRes.unresolved_pct,
          ...(tmRes.note === null ? {} : { unresolved_pct_note: tmRes.note }),
          exercises: finalRows.map((p, i) => ({
            position: i,
            exercise_id: p.exercise_id,
            section: p.section,
            sets: p.sets,
            reps: p.reps_min === p.reps_max
              ? `${p.reps_min}`
              : `${p.reps_min}-${p.reps_max}`,
            load_kg: p.load_kg,
            load_pct_tm: p.load_pct_tm,
            load_entry: p.load_entry,
            set_type: p.set_type,
            tracking: p.tracking,
            superset: p.superset_group == null
              ? null
              : String.fromCharCode(64 + p.superset_group),
          })),
          note: last === null
            ? "This day had never been trained, so it was copied exactly: no " +
              "loads or order to carry forward."
            : program.confirmed_at !== null
            ? "Live on the user's calendar now. Tell them which loads moved " +
              "and whether the order changed; anything in notes_to_consider " +
              "is a decision for you and them, not something written."
            : "The program is not confirmed yet, so nothing changed on the " +
              "calendar until confirm_program.",
        });
      }),
  );
}
