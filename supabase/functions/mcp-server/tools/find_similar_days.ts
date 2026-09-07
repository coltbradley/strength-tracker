// Recognise a day you have seen before.
//
// A coached lifter pastes the same coach screenshots again. Before this tool
// the parse could only write a fresh program every time — one program per
// screenshot, sixteen one-day programs by November — and the one thing the
// previous time PRODUCED (what was actually lifted, in what order, with what
// notes) had no way back into the next plan. The prompt calls this before
// upsert_program: when a day matches, the coach offers to repeat it with last
// time's loads instead of writing it fresh.
//
// Similarity is Jaccard over exercise ids (lib/loop.ts): the plan's structure
// (sets, loads, sections) is exactly what a repeat will change, so it must
// not count against a match. Read-only; every read is scoped to db.ownerId in
// code because this server is the service role.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";
import { lastTimeFor } from "../lib/lastTime.ts";
import {
  jaccard,
  orderDiffers,
  SIMILARITY_THRESHOLD,
} from "../lib/loop.ts";

/** How many planned days to consider, newest first. A year of four-a-week is
 *  about 200; beyond that the day is old enough that "the same day" has
 *  stopped being useful. */
const DAY_SCAN = 300;

/** PostgREST returns at most 1000 rows per request; prescriptions for 300
 *  days can exceed that, so they are paged. */
const PAGE = 1000;

interface DayRow {
  id: string;
  program_id: string;
  day_index: number;
  label: string | null;
  scheduled_date: string | null;
  notes: string | null;
  exercise_count: number;
}

interface RxRow {
  planned_workout_id: string;
  exercise_id: string;
  position: number;
}

export function registerFindSimilarDays(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "find_similar_days",
    {
      title: "Find similar planned days",
      description:
        "Planned days this user already has whose exercises overlap the list " +
        "you pass (Jaccard >= 0.6 over exercise ids), most recent first, each " +
        "with what was LOGGED against it last time: every set (load, reps, " +
        "type, load_entry, and prescribed load / rep outcome where the set " +
        "had a prescription), the lifter's set notes, and the order the " +
        "exercises were actually performed in. Call this BEFORE " +
        "upsert_program whenever you are about to write a day from a coach's " +
        "screenshot or description: if it matches a day they have trained, " +
        "offer repeat_planned_workout on the new date (last time's loads and " +
        "order come with it) instead of writing a second copy. " +
        "`notes_to_consider` are set notes that read as instructions to next " +
        "time ('could be more, maybe 70?'); act on them or ask, never copy " +
        "them into a plan. Loads are kg TOTALS; quote them back the way " +
        "load_entry says they were typed.",
      inputSchema: {
        exercise_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe(
            "Exercise ids of the day you are about to write, from " +
              "search_exercises. Order and duplicates do not matter.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Most matches to return, newest first. Default 5."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "find_similar_days", async () => {
        const query = [...new Set(args.exercise_ids)];

        // v_plan_workouts already drops templates and days of discarded
        // programs — filter there, never here (CLAUDE.md). Newest first, with
        // undated days last: an undated day has no "when" to be recent by.
        const days = must(
          await db.client
            .from("v_plan_workouts")
            .select(
              "id, program_id, day_index, label, scheduled_date, notes, exercise_count",
            )
            .eq("user_id", db.ownerId)
            .gt("exercise_count", 0)
            .order("scheduled_date", { ascending: false, nullsFirst: false })
            .order("day_index", { ascending: false })
            .limit(DAY_SCAN),
          "planned days",
        ) as unknown as DayRow[];
        if (days.length === 0) {
          return jsonResult({
            data: { query: { exercise_ids: query }, matches: [] },
            metadata: {
              threshold: SIMILARITY_THRESHOLD,
              days_considered: 0,
              note: "No planned days yet, so nothing to repeat. Write the " +
                "day with upsert_program.",
            },
          });
        }

        const dayIds = days.map((d) => d.id);
        const exercisesByDay = new Map<string, string[]>();
        for (let from = 0;; from += PAGE) {
          const page = must(
            await db.client
              .from("prescriptions")
              .select("planned_workout_id, exercise_id, position")
              .eq("user_id", db.ownerId)
              .in("planned_workout_id", dayIds)
              .order("planned_workout_id", { ascending: true })
              .order("position", { ascending: true })
              .range(from, from + PAGE - 1),
            "prescriptions",
          ) as RxRow[];
          for (const r of page) {
            const list = exercisesByDay.get(r.planned_workout_id);
            if (list === undefined) {
              exercisesByDay.set(r.planned_workout_id, [r.exercise_id]);
            } else list.push(r.exercise_id);
          }
          if (page.length < PAGE) break;
        }

        const matched = days
          .map((d) => {
            const planned = exercisesByDay.get(d.id) ?? [];
            return { day: d, planned, similarity: jaccard(query, planned) };
          })
          .filter((m) => m.similarity >= SIMILARITY_THRESHOLD)
          .slice(0, args.limit);

        if (matched.length === 0) {
          return jsonResult({
            data: { query: { exercise_ids: query }, matches: [] },
            metadata: {
              threshold: SIMILARITY_THRESHOLD,
              days_considered: days.length,
              note: "No planned day shares enough of these exercises. This " +
                "is a new day: write it with upsert_program (or add it to an " +
                "existing program with update_planned_workout).",
            },
          });
        }

        const programIds = [...new Set(matched.map((m) => m.day.program_id))];
        const programs = must(
          await db.client
            .from("programs")
            .select("id, name, confirmed_at")
            .eq("user_id", db.ownerId)
            .in("id", programIds),
          "programs",
        ) as { id: string; name: string; confirmed_at: string | null }[];
        const programById = new Map(programs.map((p) => [p.id, p] as const));

        const { byDay: lastTime, sets_truncated } = await lastTimeFor(
          db,
          matched.map((m) => m.day.id),
        );

        // Names for every exercise the answer mentions, so the reader is not
        // handed slugs. The user's own plan only names exercises they can see.
        const allIds = [
          ...new Set([...query, ...matched.flatMap((m) => m.planned)]),
        ];
        const names = must(
          await db.client.from("exercises").select("id, name").in("id", allIds),
          "exercise names",
        ) as { id: string; name: string }[];
        const nameOf = new Map(names.map((e) => [e.id, e.name] as const));

        const querySet = new Set(query);
        const matches = matched.map((m) => {
          const plannedSet = new Set(m.planned);
          const program = programById.get(m.day.program_id);
          const last = lastTime.get(m.day.id) ?? null;
          return {
            planned_workout_id: m.day.id,
            label: m.day.label,
            scheduled_date: m.day.scheduled_date,
            day_index: m.day.day_index,
            coach_notes: m.day.notes,
            program: program === undefined ? null : {
              id: program.id,
              name: program.name,
              confirmed: program.confirmed_at !== null,
            },
            similarity: Math.round(m.similarity * 100) / 100,
            // one per entry in plan order; a ramp's exercise appears once
            planned_order: [...new Set(m.planned)].map((id) => ({
              exercise_id: id,
              exercise_name: nameOf.get(id) ?? null,
            })),
            not_in_query: [...plannedSet].filter((id) => !querySet.has(id)),
            not_in_day: query.filter((id) => !plannedSet.has(id)),
            last_time: last === null ? null : {
              session: last.session,
              performed_order: last.performed_order.map((id) => ({
                exercise_id: id,
                exercise_name: nameOf.get(id) ?? null,
              })),
              order_differed: orderDiffers(m.planned, last.performed_order),
              sets: last.sets,
              notes_to_consider: last.notes_to_consider,
              other_notes: last.other_notes,
            },
          };
        });

        return jsonResult({
          data: { query: { exercise_ids: query }, matches },
          metadata: {
            threshold: SIMILARITY_THRESHOLD,
            days_considered: days.length,
            sets_truncated,
            note: "Most recent first. `last_time` is null for a day that was " +
              "planned but never trained. To schedule a match again, call " +
              "repeat_planned_workout with its planned_workout_id and the new " +
              "date; it carries last time's working loads and performed order " +
              "forward and returns notes_to_consider for you to act on. Write " +
              "fresh only when the user wants something different.",
          },
        });
      }),
  );
}
