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
  section: string | null;
  tracking: string;
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
        "`section` groups consecutive rows under a heading ('Activations', " +
        "'Abs'); `tracking` is 'reps' or 'done', where 'done' is a completion " +
        "tick for movements nobody counts. " +
        "`notes` on a day is the COACH's words from a parse; `plan_note` is " +
        "the user's own and must never be overwritten by a parse.\n\n" +
        "With no program_id this returns the NEWEST program only, which is " +
        "not always the one being asked about: the app writes its own " +
        "programs too, so more than one live confirmed program is normal. " +
        "Call list_programs first whenever the answer might involve a plan " +
        "you did not just write, and pass its id here.",
      inputSchema: {
        program_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Read ONE specific program, from list_programs. Omit to get the " +
              "newest one. An explicit id is honoured whether or not the " +
              "program is confirmed — you asked for that program.",
          ),
        include_unconfirmed: z
          .boolean()
          .default(false)
          .describe(
            "Only used when program_id is omitted. Include programs still " +
              "awaiting the user's approval (confirmed_at IS NULL). Default " +
              "false: an unconfirmed program is a proposal, not the plan.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_program", async () => {
        // Scoped by owner and to LIVE programs in both branches. The service
        // role bypasses RLS; nothing below is doing this for us.
        let q = db.client
          .from("programs")
          .select("id, name, source_note, confirmed_at, created_at")
          .eq("user_id", db.ownerId)
          .is("discarded_at", null);
        if (args.program_id !== undefined) {
          // An explicit id is an explicit answer: no created_at ordering, and
          // no confirmed filter. This tool could previously see nothing but
          // the newest program, and since the PWA started writing its own
          // confirmed programs, "newest" and "the one we are talking about"
          // stopped being the same row — so a coach-parsed block still on the
          // calendar became invisible, and the next edit "replaced" a plan
          // from a baseline that was never it.
          q = q.eq("id", args.program_id);
        } else {
          q = q.order("created_at", { ascending: false }).limit(1);
          if (!args.include_unconfirmed) q = q.not("confirmed_at", "is", null);
        }

        const programs = must(await q, "programs") as unknown as {
          id: string;
          name: string;
          source_note: string | null;
          confirmed_at: string | null;
          created_at: string;
        }[];
        const program = programs[0];
        if (program === undefined && args.program_id !== undefined) {
          // A named id that is not here is a mistake to report, not an empty
          // plan to hand back: silently answering "no program" would read as
          // "the plan is gone".
          throw new ToolError(
            `No live program with id ${args.program_id} belongs to this ` +
              "user. It may have been deleted or superseded. Call " +
              "list_programs for the current ids.",
          );
        }
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
                      "set_type, section, tracking, sets, reps_min, reps_max, load_kg, load_pct_tm, " +
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

/**
 * The index get_program needs to be usable.
 *
 * get_program takes an id now, and nothing produced one. Worse, its no-id
 * behaviour — newest live program — was written when Claude was the only
 * writer of programs and the newest was always the one under discussion. The
 * PWA now creates confirmed programs of its own (a user-authored day makes
 * one), so TWO live confirmed programs is an ordinary state, and "newest" can
 * be the app's while the coach-parsed block the user is asking about sits
 * underneath it, unreadable. From there every edit is made against a baseline
 * that was never the plan.
 *
 * Cheap on purpose: names, counts and the span of dates, so the model can pick
 * the right id and then spend the round trip on get_program. Scoped to
 * db.ownerId, like everything else here.
 */
export function registerListPrograms(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "list_programs",
    {
      title: "List programs",
      description:
        "Every live program: id, name, whether it is confirmed, how many days " +
        "it has and the range of dates those days cover. Read this FIRST " +
        "whenever a plan is in question and you did not just write it — more " +
        "than one confirmed program can be live at a time (the app writes its " +
        "own, and the user can keep a coach block alongside it), so " +
        "get_program's default of 'the newest one' may not be the one being " +
        "discussed. Take the id from here and pass it to get_program. " +
        "Discarded programs are not listed; an UNCONFIRMED one is a proposal " +
        "still waiting for the user's approval in chat.",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(ctx, "list_programs", async () => {
        const programs = must(
          await db.client
            .from("programs")
            .select("id, name, source_note, confirmed_at, created_at")
            .eq("user_id", db.ownerId)
            .is("discarded_at", null)
            .order("created_at", { ascending: false }),
          "programs",
        ) as unknown as {
          id: string;
          name: string;
          source_note: string | null;
          confirmed_at: string | null;
          created_at: string;
        }[];

        // Counted through v_plan_workouts, the same view get_program reads, so
        // a program's day count here is the number of days it will actually
        // return: templates (dateless saved days) and days of a discarded
        // program are already gone at the view.
        const days = programs.length === 0
          ? []
          : (must(
              await db.client
                .from("v_plan_workouts")
                .select("program_id, scheduled_date")
                .eq("user_id", db.ownerId)
                .in(
                  "program_id",
                  programs.map((p) => p.id),
                ),
              "v_plan_workouts",
            ) as unknown as {
              program_id: string;
              scheduled_date: string | null;
            }[]);

        const stats = new Map<
          string,
          { count: number; first: string | null; last: string | null }
        >();
        for (const d of days) {
          const s = stats.get(d.program_id) ??
            { count: 0, first: null, last: null };
          s.count += 1;
          if (d.scheduled_date !== null) {
            // ISO dates sort lexically, which is the whole reason the column
            // is a date and not a locale string.
            if (s.first === null || d.scheduled_date < s.first) {
              s.first = d.scheduled_date;
            }
            if (s.last === null || d.scheduled_date > s.last) {
              s.last = d.scheduled_date;
            }
          }
          stats.set(d.program_id, s);
        }

        const rows = programs.map((p) => {
          const s = stats.get(p.id);
          return {
            id: p.id,
            name: p.name,
            source_note: p.source_note,
            confirmed: p.confirmed_at !== null,
            confirmed_at: p.confirmed_at,
            created_at: p.created_at,
            workout_count: s?.count ?? 0,
            first_scheduled_date: s?.first ?? null,
            last_scheduled_date: s?.last ?? null,
          };
        });

        return jsonResult({
          data: { programs: rows },
          metadata: {
            count: rows.length,
            confirmed_count: rows.filter((r) => r.confirmed).length,
            note:
              "Newest first. Days with no scheduled_date are counted but " +
              "leave the date range unchanged, so a program can hold days and " +
              "still show a null range. Pass an id to get_program to read one " +
              "of these in full; an unconfirmed program needs confirm_program " +
              "after the user approves it in chat.",
          },
        });
      }),
  );
}
