// The plan above the program.
//
// A plan is the STRATEGY: where this person is going over months, in what
// phases, with what emphasis and what progression rule. A program is a set of
// days; a day is a set of prescriptions. Until this existed the hierarchy
// stopped at program, so every strategic fact lived in a chat that is gone, and
// the coach minted one program per screenshot because there was nothing above
// `programs` to file a day under.
//
// Three tools. `get_training_plan` reads the live plan and says which phase
// TODAY falls in, so a client with no context block can still build against
// it. `set_training_plan` writes a NEW plan, supersedes the old one, and lands
// unconfirmed; `confirm_training_plan` makes it live. The in-app coach has the
// first and not the other two: they are switched off at the connector layer
// (supabase/functions/coach/index.ts), because strategy is set at a desk with
// time to think and tactics are set between sets, and a coach that can rewrite
// the strategy mid-workout because the lifter is tired is the wrong coach.
//
// Everything here is scoped to db.ownerId in code. The server runs as the
// service role and RLS is not doing it for us.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, visibleExerciseIds } from "../lib/db.ts";
import { assertIsoDate, todayIso } from "../lib/dates.ts";
import {
  guard,
  jsonResult,
  type RequestContext,
  ToolError,
} from "../lib/errors.ts";
import { log } from "../lib/log.ts";

const phaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .describe("Short name, e.g. 'Accumulation', 'Intensification', 'Peak'."),
  starts_on: z
    .string()
    .describe("First day of the phase, YYYY-MM-DD in the user's timezone."),
  ends_on: z
    .string()
    .describe(
      "Last day of the phase, YYYY-MM-DD, inclusive. Phases may not share a " +
        "day: end each one the day before the next begins. A gap between " +
        "phases (a rest week) is allowed.",
    ),
  focus: z
    .string()
    .max(300)
    .optional()
    .describe(
      "What this phase is FOR, in the coach's words: 'hypertrophy on the " +
        "squat pattern, maintain pull'. The in-app coach reads it on every " +
        "turn and checks each day it writes against it, so say what matters " +
        "and stop.",
    ),
  progression: z
    .string()
    .max(300)
    .optional()
    .describe(
      "The rule for moving load or volume inside this phase: 'add 2.5 kg " +
        "when every working set hits the top of the range'. A rule, not a " +
        "number — the numbers live in prescriptions.",
    ),
  sessions_per_week: z.number().int().min(1).max(14).optional(),
  primary_exercise_ids: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      "The lifts this phase is built around, as exercise ids from " +
        "search_exercises. Every id must exist and be visible to this user.",
    ),
  notes: z.string().max(1000).optional(),
});

export type PhaseInput = z.infer<typeof phaseSchema>;

interface PlanRow {
  id: string;
  objective: string;
  starts_on: string;
  ends_on: string;
  source_note: string | null;
  confirmed_at: string | null;
  created_at: string;
}

interface PhaseRow {
  id: string;
  position: number;
  name: string;
  starts_on: string;
  ends_on: string;
  focus: string | null;
  progression: string | null;
  sessions_per_week: number | null;
  primary_exercise_ids: string[];
  notes: string | null;
}

/**
 * Validate a plan's phases before Postgres sees them, and return the plan's
 * effective dates.
 *
 * The trigger in the database refuses an overlap with an exclusion-class
 * SQLSTATE, which the guard would report as "Unexpected server error" — a
 * generic 500 for what is really a date the model could fix on the next call.
 * Everything checked here is checked so the FIRST thing the model sees names
 * the phase and the day.
 *
 * Rules: every date is a real calendar date; each phase ends on or after it
 * starts; phases are given in chronological order and no two share a day (a
 * gap between them is fine — a rest week is a legitimate thing to plan); when
 * the plan's own dates are given, every phase falls inside them, and when they
 * are omitted they are the first phase's start and the last phase's end.
 *
 * Pure, and exported for the test.
 */
export function validatePhases(
  phases: PhaseInput[],
  plan: { starts_on?: string; ends_on?: string },
): { starts_on: string; ends_on: string } {
  if (phases.length === 0) {
    throw new ToolError("A plan needs at least one phase.");
  }
  for (const [i, p] of phases.entries()) {
    assertIsoDate(p.starts_on, `phases[${i}].starts_on`);
    assertIsoDate(p.ends_on, `phases[${i}].ends_on`);
    if (p.ends_on < p.starts_on) {
      throw new ToolError(
        `Phase "${p.name}" ends (${p.ends_on}) before it starts (${p.starts_on}).`,
      );
    }
  }
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const cur = phases[i];
    if (cur.starts_on <= prev.starts_on) {
      throw new ToolError(
        `Phases must be listed in chronological order: "${cur.name}" ` +
          `(from ${cur.starts_on}) is listed after "${prev.name}" (from ` +
          `${prev.starts_on}). Reorder the array; position follows it.`,
      );
    }
    if (cur.starts_on <= prev.ends_on) {
      throw new ToolError(
        `Phases "${prev.name}" (${prev.starts_on} to ${prev.ends_on}) and ` +
          `"${cur.name}" (${cur.starts_on} to ${cur.ends_on}) overlap. ` +
          "Phases may not share a day: end the first the day before the " +
          "second begins.",
      );
    }
  }

  const first = phases[0].starts_on;
  const last = phases[phases.length - 1].ends_on;
  const starts_on = plan.starts_on === undefined
    ? first
    : assertIsoDate(plan.starts_on, "starts_on");
  const ends_on = plan.ends_on === undefined
    ? last
    : assertIsoDate(plan.ends_on, "ends_on");
  if (ends_on < starts_on) {
    throw new ToolError(
      `The plan ends (${ends_on}) before it starts (${starts_on}).`,
    );
  }
  if (first < starts_on || last > ends_on) {
    throw new ToolError(
      `The phases run ${first} to ${last}, outside the plan's own dates ` +
        `(${starts_on} to ${ends_on}). Widen the plan or omit starts_on and ` +
        "ends_on to derive them from the phases.",
    );
  }
  return { starts_on, ends_on };
}

type PhaseStatus = "past" | "current" | "upcoming";

function phaseStatus(p: { starts_on: string; ends_on: string }, today: string): PhaseStatus {
  if (p.ends_on < today) return "past";
  if (p.starts_on > today) return "upcoming";
  return "current";
}

/** The live plan, or null. One per user by the partial unique index. */
async function livePlan(db: Db): Promise<PlanRow | null> {
  const { data, error } = await db.client
    .from("training_plans")
    .select(
      "id, objective, starts_on, ends_on, source_note, confirmed_at, created_at",
    )
    .eq("user_id", db.ownerId)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw new Error(`live plan lookup: ${error.message}`);
  return (data as PlanRow | null) ?? null;
}

export function registerGetTrainingPlan(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_training_plan",
    {
      title: "Get training plan",
      description:
        "The user's long-term training plan: the objective, its dated phases " +
        "in order, and which phase TODAY falls in. A plan is the STRATEGY " +
        "above programs — 'accumulation through October, then four weeks of " +
        "intensification' — and every day written or edited should fit the " +
        "current phase's focus and progression. Each phase lists the live " +
        "programs filed under it; pass a phase's id as upsert_program's " +
        "phase_id to add parsed days to that phase's program instead of " +
        "creating another. There is at most one live plan; an unconfirmed one " +
        "is a proposal awaiting the user's approval and is returned with " +
        "confirmed=false.",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(ctx, "get_training_plan", async () => {
        const plan = await livePlan(db);
        if (plan === null) {
          return jsonResult({
            data: { plan: null, current_phase: null, next_phase: null, phases: [] },
            metadata: {
              note:
                "No training plan. set_training_plan writes one; it is " +
                "available from Claude Desktop and switched off for the " +
                "in-app coach, so from the app the answer is 'set it up " +
                "from Desktop'.",
            },
          });
        }

        const phases = must(
          await db.client
            .from("plan_phases")
            .select(
              "id, position, name, starts_on, ends_on, focus, progression, " +
                "sessions_per_week, primary_exercise_ids, notes",
            )
            .eq("user_id", db.ownerId)
            .eq("plan_id", plan.id)
            .order("position", { ascending: true }),
          "plan phases",
        ) as unknown as PhaseRow[];

        // Programs filed under each phase, live ones only.
        const programs = phases.length === 0 ? [] : (must(
          await db.client
            .from("programs")
            .select("id, name, confirmed_at, phase_id")
            .eq("user_id", db.ownerId)
            .is("discarded_at", null)
            .in("phase_id", phases.map((p) => p.id)),
          "programs by phase",
        ) as unknown as {
          id: string;
          name: string;
          confirmed_at: string | null;
          phase_id: string;
        }[]);
        const programsByPhase = new Map<string, { id: string; name: string; confirmed: boolean }[]>();
        for (const p of programs) {
          const list = programsByPhase.get(p.phase_id) ?? [];
          list.push({ id: p.id, name: p.name, confirmed: p.confirmed_at !== null });
          programsByPhase.set(p.phase_id, list);
        }

        // Names for the primary lifts, through the same visibility gate every
        // exercise read takes. An id that no longer resolves is returned bare.
        const allIds = [...new Set(phases.flatMap((p) => p.primary_exercise_ids ?? []))];
        const names = new Map<string, string>();
        if (allIds.length > 0) {
          const visible = await visibleExerciseIds(db, allIds);
          if (visible.size > 0) {
            const rows = must(
              await db.client
                .from("exercises")
                .select("id, name")
                .in("id", [...visible]),
              "exercise names",
            ) as { id: string; name: string }[];
            for (const r of rows) names.set(r.id, r.name);
          }
        }

        const today = await todayIso(db);
        const shaped = phases.map((p) => ({
          id: p.id,
          position: p.position,
          name: p.name,
          starts_on: p.starts_on,
          ends_on: p.ends_on,
          status: phaseStatus(p, today),
          focus: p.focus,
          progression: p.progression,
          sessions_per_week: p.sessions_per_week,
          primary_exercises: (p.primary_exercise_ids ?? []).map((id) => ({
            id,
            name: names.get(id) ?? null,
          })),
          notes: p.notes,
          programs: programsByPhase.get(p.id) ?? [],
        }));
        const current = shaped.find((p) => p.status === "current") ?? null;
        const next = shaped.find((p) => p.status === "upcoming") ?? null;

        return jsonResult({
          data: {
            plan: {
              id: plan.id,
              objective: plan.objective,
              starts_on: plan.starts_on,
              ends_on: plan.ends_on,
              source_note: plan.source_note,
              confirmed: plan.confirmed_at !== null,
              confirmed_at: plan.confirmed_at,
              created_at: plan.created_at,
            },
            current_phase: current === null
              ? null
              : { id: current.id, name: current.name, position: current.position },
            next_phase: next === null
              ? null
              : { id: next.id, name: next.name, starts_on: next.starts_on },
            phases: shaped,
          },
          metadata: {
            today,
            phase_count: shaped.length,
            note: plan.confirmed_at === null
              ? "This plan is UNCONFIRMED: a proposal, not yet the plan. It " +
                "becomes live with confirm_training_plan after the user " +
                "approves it in chat."
              : current === null
              ? "No phase covers today" +
                (next === null
                  ? "; the plan's last phase has ended."
                  : `; the next one, "${next.name}", starts ${next.starts_on}.`)
              : `Today is in phase ${current.position + 1} of ${shaped.length}, ` +
                `"${current.name}". Days written or edited should fit its ` +
                "focus and progression.",
          },
        });
      }),
  );
}

export function registerSetTrainingPlan(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "set_training_plan",
    {
      title: "Set training plan",
      description:
        "Write the user's long-term training plan: an objective and its " +
        "dated phases, each with a focus and a progression rule. This is the " +
        "STRATEGY above programs, written rarely and revised deliberately. " +
        "It writes a NEW plan and supersedes the current one (the old plan " +
        "stays in the database as history), so to revise a plan restate all " +
        "of it — read get_training_plan first. The new plan lands UNCONFIRMED " +
        "and steers nothing until confirm_training_plan is called after the " +
        "user approves it in chat; because the old plan is superseded at " +
        "once, the app shows no plan between this call and that one, so " +
        "confirm in the same conversation. Phases are listed in order, may " +
        "not share a day, and every primary_exercise_id must exist (use " +
        "search_exercises).",
      inputSchema: {
        objective: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            "Where this person is going, in a sentence or two: 'Squat 200 kg " +
              "by March; keep the press moving; stay under 90 kg bodyweight'. " +
              "Read by the in-app coach on every turn, so short.",
          ),
        starts_on: z
          .string()
          .optional()
          .describe(
            "First day of the plan, YYYY-MM-DD. Omit to use the first " +
              "phase's start.",
          ),
        ends_on: z
          .string()
          .optional()
          .describe(
            "Last day of the plan, YYYY-MM-DD. Omit to use the last phase's " +
              "end. May run past the last phase when later phases are not " +
              "yet decided.",
          ),
        source_note: z
          .string()
          .max(120)
          .optional()
          .describe(
            "Provenance in a few words: 'coach's block plan, 2026-09-05'. " +
              "Not parse commentary.",
          ),
        phases: z
          .array(phaseSchema)
          .min(1)
          .max(12)
          .describe(
            "The phases in chronological order. Position follows the array.",
          ),
      },
    },
    (args) =>
      guard(ctx, "set_training_plan", async () => {
        const dates = validatePhases(args.phases, {
          starts_on: args.starts_on,
          ends_on: args.ends_on,
        });

        // Every primary lift must exist AND be visible to this owner — the
        // same gate the plan-writing tools use for prescriptions. Another
        // account's custom exercise reports as unknown, never as forbidden.
        const ids = [
          ...new Set(args.phases.flatMap((p) => p.primary_exercise_ids ?? [])),
        ];
        if (ids.length > 0) {
          const known = await visibleExerciseIds(db, ids);
          const unknown = ids.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throw new ToolError(
              `Unknown exercise ids in primary_exercise_ids: ${unknown.join(", ")}. ` +
                "Search the library with search_exercises and use the exact " +
                "id, or add_exercise it first.",
            );
          }
        }

        const previous = await livePlan(db);

        // One live plan per user is a partial unique index, so the old plan
        // has to be superseded BEFORE the new row can exist. That opens a
        // window with no live plan; a failure inside it is compensated below
        // by putting the old plan back, and the whole thing is reported
        // rather than left half-done. PostgREST has no transactions.
        const supersededAt = new Date().toISOString();
        if (previous !== null) {
          const { error } = await db.client
            .from("training_plans")
            .update({ superseded_at: supersededAt })
            .eq("id", previous.id)
            .eq("user_id", db.ownerId)
            .is("superseded_at", null);
          if (error) throw new Error(`supersede plan: ${error.message}`);
        }

        let planId: string | null = null;
        try {
          const inserted = must(
            await db.client
              .from("training_plans")
              .insert({
                user_id: db.ownerId,
                objective: args.objective,
                starts_on: dates.starts_on,
                ends_on: dates.ends_on,
                source_note: args.source_note ?? null,
                confirmed_at: null,
              })
              .select("id")
              .single(),
            "insert plan",
          ) as { id: string };
          planId = inserted.id;

          // EVERY column on EVERY row. PostgREST builds a bulk insert from the
          // union of the rows' keys and fills a missing one with NULL, not
          // with the column default (see prescriptionRows).
          const { error: phaseError } = await db.client
            .from("plan_phases")
            .insert(
              args.phases.map((p, i) => ({
                user_id: db.ownerId,
                plan_id: planId,
                position: i,
                name: p.name,
                starts_on: p.starts_on,
                ends_on: p.ends_on,
                focus: p.focus ?? null,
                progression: p.progression ?? null,
                sessions_per_week: p.sessions_per_week ?? null,
                primary_exercise_ids: p.primary_exercise_ids ?? [],
                notes: p.notes ?? null,
              })),
            );
          if (phaseError) {
            throw new Error(`insert phases: ${phaseError.message}`);
          }
        } catch (err) {
          // Compensate: remove the fragment nobody saw, put the old plan
          // back. Either failing is logged, never swallowed, and the caller
          // still sees the original error.
          if (planId !== null) {
            const { error } = await db.client
              .from("training_plans")
              .delete()
              .eq("id", planId)
              .eq("user_id", db.ownerId);
            if (error) {
              log("error", "set_training_plan_cleanup_failed", {
                request_id: ctx.requestId,
                tool: "set_training_plan",
                plan_id: planId,
                error: error.message,
              });
            }
          }
          if (previous !== null) {
            const { error } = await db.client
              .from("training_plans")
              .update({ superseded_at: null })
              .eq("id", previous.id)
              .eq("user_id", db.ownerId)
              .eq("superseded_at", supersededAt);
            if (error) {
              log("error", "set_training_plan_restore_failed", {
                request_id: ctx.requestId,
                tool: "set_training_plan",
                plan_id: previous.id,
                error: error.message,
              });
            }
          }
          throw err;
        }

        const phases = must(
          await db.client
            .from("plan_phases")
            .select("id, position, name, starts_on, ends_on")
            .eq("user_id", db.ownerId)
            .eq("plan_id", planId)
            .order("position", { ascending: true }),
          "read back phases",
        ) as { id: string; position: number; name: string; starts_on: string; ends_on: string }[];

        const lines = [
          `## Plan written: ${args.objective}`,
          "",
          `${dates.starts_on} to ${dates.ends_on}`,
          "",
          "| # | Phase | From | To | Focus | Progression |",
          "| --- | --- | --- | --- | --- | --- |",
          ...args.phases.map((p, i) =>
            `| ${i + 1} | ${p.name} | ${p.starts_on} | ${p.ends_on} | ${p.focus ?? ""} | ${p.progression ?? ""} |`
          ),
          "",
          "This plan is UNCONFIRMED. Review it with the user; after explicit " +
          `approval in chat, call confirm_training_plan with plan_id ${planId}.`,
        ];
        if (previous !== null) {
          lines.push(
            "",
            previous.confirmed_at !== null
              ? `The previous CONFIRMED plan (${previous.id}) is superseded as of ` +
                "now, so the app shows no plan until this one is confirmed. " +
                "Confirm it in this conversation."
              : `The previous unconfirmed draft (${previous.id}) is superseded.`,
          );
        }

        return jsonResult(
          {
            plan_id: planId,
            confirmed: false,
            starts_on: dates.starts_on,
            ends_on: dates.ends_on,
            superseded_plan_id: previous?.id ?? null,
            superseded_plan_was_confirmed: previous !== null &&
              previous.confirmed_at !== null,
            phases,
          },
          lines.join("\n"),
        );
      }),
  );
}

export function registerConfirmTrainingPlan(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "confirm_training_plan",
    {
      title: "Confirm training plan",
      description:
        "Mark a plan written by set_training_plan as confirmed, making it the " +
        "plan the app and the in-app coach build against. REQUIRES EXPLICIT " +
        "USER APPROVAL IN CHAT FIRST: only call this after the user has " +
        "reviewed the plan summary and clearly said to confirm it. " +
        "Confirmation is one-way; a change after this is a new " +
        "set_training_plan.",
      inputSchema: {
        plan_id: z
          .string()
          .uuid()
          .describe("The plan_id returned by set_training_plan."),
      },
    },
    (args) =>
      guard(ctx, "confirm_training_plan", async () => {
        const { data, error } = await db.client
          .from("training_plans")
          .update({ confirmed_at: new Date().toISOString() })
          .eq("id", args.plan_id)
          .eq("user_id", db.ownerId)
          .is("confirmed_at", null)
          // A superseded plan must not be confirmable back into existence.
          .is("superseded_at", null)
          .select("id, objective, confirmed_at");
        if (error) throw new Error(`confirm plan: ${error.message}`);

        if (data && data.length > 0) {
          const row = data[0] as { id: string; objective: string; confirmed_at: string };
          return jsonResult({
            plan_id: row.id,
            objective: row.objective,
            confirmed_at: row.confirmed_at,
            status: "confirmed",
          });
        }

        // Nothing updated: say which of the three reasons, as confirm_program
        // does. "Already confirmed" next to confirmed_at: null is a
        // contradiction, and it sent a model away believing the work was done.
        const { data: existing, error: lookupError } = await db.client
          .from("training_plans")
          .select("id, objective, confirmed_at, superseded_at")
          .eq("id", args.plan_id)
          .eq("user_id", db.ownerId)
          .maybeSingle();
        if (lookupError) throw new Error(`plan lookup: ${lookupError.message}`);
        if (!existing) {
          throw new ToolError(
            `No plan found with id ${args.plan_id}. It may belong to another ` +
              "user. Call get_training_plan for the live plan's id.",
          );
        }
        const row = existing as {
          id: string;
          objective: string;
          confirmed_at: string | null;
          superseded_at: string | null;
        };
        if (row.superseded_at !== null) {
          throw new ToolError(
            `Plan ${row.id} was superseded on ${row.superseded_at} and cannot ` +
              "be confirmed. A newer set_training_plan replaced it; call " +
              "get_training_plan for the plan that is actually waiting for " +
              "approval and confirm THAT one.",
          );
        }
        if (row.confirmed_at === null) {
          throw new ToolError(
            `Plan ${row.id} is still unconfirmed but the confirmation did not ` +
              "apply. Nothing changed — retry, and if it fails again say so " +
              "rather than treating it as confirmed.",
          );
        }
        return jsonResult({
          plan_id: row.id,
          objective: row.objective,
          confirmed_at: row.confirmed_at,
          status: "already_confirmed",
        });
      }),
  );
}
