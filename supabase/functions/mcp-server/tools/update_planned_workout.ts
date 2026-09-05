// Edit ONE day of an existing program, in place.
//
// This exists because `upsert_program` cannot. It replaces an UNCONFIRMED
// program wholesale and refuses to touch a confirmed one, so "add the PULL day
// to my plan" had no correct call: the model could only write a second program
// with the same name, leaving two live plans and a calendar full of days the
// lifter never trained. That happened to a real user on 2026-08-31 and was
// reproduced with a different model in the eval, which is how we know it was
// the tool surface and not the model's judgment.
//
// The wholesale rewrite had a second failure with the same root: a day with no
// prescriptions cannot be restated (the array requires at least one), so any
// rewrite silently dropped every empty day. Editing one day never restates the
// others, so both go away together.
//
// The unit here is the DAY. Its prescriptions are replaced entirely, which is
// the honest granularity: order, supersets, sections and ramps are all
// adjacency between rows, so a per-row patch API would let a caller tear a
// superset in half without ever naming it.

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
import {
  assertExercisesExist,
  assertSupersetGroups,
  prescriptionRows,
  prescriptionSchema,
  resolveTrainingMaxes,
} from "../lib/prescriptions.ts";

/** New rows land here first, above anything real, so the day is never empty
 *  between statements. PostgREST has no transactions and (planned_workout_id,
 *  position) is unique, so the new list cannot occupy its final positions
 *  while the old list still holds them. */
const PARK = 10_000;

interface DayRow {
  id: string;
  label: string | null;
  scheduled_date: string | null;
  is_template: boolean;
  programs: { id: string; name: string; confirmed_at: string | null } | null;
}

export function registerUpdatePlannedWorkout(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "update_planned_workout",
    {
      title: "Update one planned day",
      description:
        "Replace the exercises on ONE planned day, leaving the rest of the " +
        "program untouched. This is the tool for editing a plan the user is " +
        "already following: filling in an empty day, swapping an exercise, " +
        "adding a superset, changing sets or loads, or MOVING the day to " +
        "another date. Prefer it over " +
        "upsert_program for ANY change to an existing program — " +
        "upsert_program rewrites a whole program and cannot touch a confirmed " +
        "one, so using it to edit leaves the user with two competing plans. " +
        "Reserve upsert_program for a genuinely new program.\n\n" +
        "If you pass `prescriptions`, the day's exercises are replaced by that " +
        "list, in the order you pass them, so restate the exercises you want " +
        "to KEEP as well as the ones you are changing; an empty list clears " +
        "the day. Omit `prescriptions` to leave the exercises alone — that is " +
        "how you move a day ('do it today instead'): pass scheduled_date and " +
        "nothing else. Get the day's id from get_program.\n\n" +
        "Changing a day on a CONFIRMED program takes effect immediately on " +
        "the user's calendar, so it needs confirm_change=true and their " +
        "approval in chat first.",
      inputSchema: {
        planned_workout_id: z
          .string()
          .uuid()
          .describe("The day's id, from get_program."),
        prescriptions: z
          .array(prescriptionSchema)
          .max(50)
          .optional()
          .describe(
            "The day's complete new exercise list, in order. Anything you " +
              "leave out is removed from the day. An empty array clears it. " +
              "OMIT the field entirely to keep the day's exercises as they " +
              "are (rename, re-note or move the day without restating them).",
          ),
        scheduled_date: z
          .string()
          .optional()
          .describe(
            "Move the day to this calendar date, YYYY-MM-DD in the user's " +
              "own timezone. Omit to leave it where it is. A day scheduled " +
              "tomorrow that the user wants to train today is this field and " +
              "nothing else; the exercises need not be restated.",
          ),
        label: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe("Rename the day, e.g. 'PULL'. Omit to leave it alone."),
        notes: z
          .string()
          .max(300)
          .optional()
          .describe(
            "The coach's OWN words for the day, brief. This shows on the " +
              "user's phone mid-workout — keep parse commentary and " +
              "explanations out of it and say those in chat. Omit to leave " +
              "the existing note alone.",
          ),
        confirm_change: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to change a day on a CONFIRMED program. Set it " +
              "only after the user approved this specific change in chat, in " +
              "their own words, in a message you can point to.",
          ),
      },
    },
    (args) =>
      guard(ctx, "update_planned_workout", async () => {
        const days = must(
          await db.client
            .from("planned_workouts")
            .select(
              "id, label, scheduled_date, is_template, programs!inner(id, name, confirmed_at)",
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
              "get_program for the current day ids.",
          );
        }
        const day = days[0];
        const program = Array.isArray(day.programs)
          ? day.programs[0]
          : day.programs;
        if (!program) {
          throw new ToolError(
            `Planned day ${day.id} has no live program. Nothing to edit.`,
          );
        }

        if (
          args.prescriptions === undefined &&
          args.label === undefined &&
          args.notes === undefined &&
          args.scheduled_date === undefined
        ) {
          throw new ToolError(
            "Nothing to change: pass prescriptions, label, notes or " +
              "scheduled_date.",
          );
        }

        if (args.scheduled_date !== undefined) {
          // Shape AND existence: 2026-02-30 matches the regex and would land
          // as an opaque Postgres error, so this names the parameter.
          assertIsoDate(args.scheduled_date, "scheduled_date");
          if (day.is_template) {
            throw new ToolError(
              "This day is a saved TEMPLATE and has no place on the " +
                "calendar (a template can never carry a date). Apply it to a " +
                "day in the app, or edit a dated day instead.",
            );
          }
        }

        if (program.confirmed_at !== null && !args.confirm_change) {
          throw new ToolError(
            `'${program.name}' is CONFIRMED — the plan the user is following, ` +
              "so this edit is live the moment it lands. Show them what you " +
              "intend to change, get their approval in chat, then retry with " +
              "confirm_change=true.",
          );
        }

        // Everything about the exercise list only happens when a list was
        // passed. A date move or a rename leaves the prescriptions — and
        // their ids, which logged sets may point at — exactly where they are,
        // which is also why the trained-day refusal below does not apply to
        // it: moving a day changes nothing adherence reads.
        let replaced = 0;
        if (args.prescriptions !== undefined) {
        const prescriptions = args.prescriptions;
        // Both plan-writing doors validate identically, on purpose: a day
        // this tool would refuse must not be writable through upsert_program,
        // and vice versa.
        assertSupersetGroups(prescriptions, "this day");
        await assertExercisesExist(db, prescriptions);
        await resolveTrainingMaxes(db, prescriptions);

        // What is on the day now, and has any of it been trained?
        const existing = must(
          await db.client
            .from("prescriptions")
            .select("id, exercise_id, position")
            .eq("user_id", db.ownerId)
            .eq("planned_workout_id", day.id),
          "existing prescriptions",
        ) as { id: string; exercise_id: string; position: number }[];

        if (existing.length > 0) {
          // Matches the before-delete trigger, which reads `sets` and not
          // `v_live_sets`: a voided set still means this prescription was
          // trained, and severing it would take the plan half of a logged
          // session's adherence with it.
          const logged = must(
            await db.client
              .from("sets")
              .select("prescription_id")
              .eq("user_id", db.ownerId)
              .in(
                "prescription_id",
                existing.map((p) => p.id),
              ),
            "logged set check",
          ) as { prescription_id: string }[];

          if (logged.length > 0) {
            const trained = new Set(logged.map((s) => s.prescription_id));
            const names = existing
              .filter((p) => trained.has(p.id))
              .map((p) => p.exercise_id);
            throw new ToolError(
              `This day has already been trained — ${
                [...new Set(names)].join(", ")
              } ` +
                "has logged sets against it. Editing it would cut those sets " +
                "off from what the plan asked for, which is how adherence is " +
                "read, so it is refused. Edit a FUTURE day instead, or tell " +
                "the user to adjust this one in the app.",
            );
          }
        }

        const rows = prescriptionRows(db.ownerId, day.id, prescriptions);

        // Park -> delete -> land. A failure between statements leaves the day
        // holding both lists, which is visible and fixable on the next call;
        // deleting first would leave it empty, which is the failure this whole
        // tool exists to stop.
        if (rows.length > 0) {
          const parked = rows.map((r, i) => ({ ...r, position: PARK + i }));
          const { error } = await db.client
            .from("prescriptions")
            .insert(parked);
          if (error) throw new Error(`stage prescriptions: ${error.message}`);
        }

        if (existing.length > 0) {
          const { error } = await db.client
            .from("prescriptions")
            .delete()
            .eq("user_id", db.ownerId)
            .eq("planned_workout_id", day.id)
            .lt("position", PARK);
          if (error) {
            throw new Error(`remove old prescriptions: ${error.message}`);
          }
        }

        for (let i = 0; i < rows.length; i++) {
          const { error } = await db.client
            .from("prescriptions")
            .update({ position: i })
            .eq("user_id", db.ownerId)
            .eq("planned_workout_id", day.id)
            .eq("position", PARK + i);
          if (error) {
            throw new Error(`position prescriptions: ${error.message}`);
          }
        }
        replaced = existing.length;
        }

        const dayPatch: Record<string, unknown> = {};
        if (args.label !== undefined) dayPatch.label = args.label;
        if (args.notes !== undefined) dayPatch.notes = args.notes;
        if (args.scheduled_date !== undefined) {
          dayPatch.scheduled_date = args.scheduled_date;
        }
        if (Object.keys(dayPatch).length > 0) {
          const { error } = await db.client
            .from("planned_workouts")
            .update(dayPatch)
            .eq("user_id", db.ownerId)
            .eq("id", day.id);
          if (error) throw new Error(`update day: ${error.message}`);
        }

        return jsonResult({
          updated: true,
          planned_workout_id: day.id,
          label: args.label ?? day.label,
          scheduled_date: args.scheduled_date ?? day.scheduled_date,
          moved_from: args.scheduled_date !== undefined &&
              args.scheduled_date !== day.scheduled_date
            ? day.scheduled_date
            : null,
          is_template: day.is_template,
          program: {
            id: program.id,
            name: program.name,
            confirmed: program.confirmed_at !== null,
          },
          exercises_replaced: args.prescriptions !== undefined,
          replaced,
          now: args.prescriptions?.length ?? null,
          exercises: (args.prescriptions ?? []).map((p, i) => ({
            position: i,
            exercise_id: p.exercise_id,
            sets: p.sets,
            reps: p.reps_min === p.reps_max
              ? `${p.reps_min}`
              : `${p.reps_min}-${p.reps_max}`,
            superset: p.superset_group == null
              ? null
              : String.fromCharCode(64 + p.superset_group),
          })),
          note: program.confirmed_at !== null
            ? "Live on the user's calendar now. No confirm step: the day was " +
              "edited in place, not written as a new program."
            : "This program is not confirmed yet, so nothing changed on the " +
              "user's calendar. confirm_program makes the whole program live.",
        });
      }),
  );
}
