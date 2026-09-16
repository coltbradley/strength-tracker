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
 * The coach's own conclusions from the numbers, each with an optional
 * check-back date — `coach_observations`, distinct from `coach_memory`
 * (standing facts about the person) and from `goals` (measured against real
 * sets). Written only here, as the service role: RLS gives the owner select
 * and delete but no insert or update, so a lifter cannot author or edit the
 * coach's own opinion by hand.
 */

const TOPICS = [
  "bodyweight",
  "fueling",
  "recovery",
  "lift",
  "injury",
  "other",
] as const;

const STATUSES = ["open", "resolved", "superseded"] as const;

interface ObservationRow {
  id: string;
  topic: string;
  observation: string;
  recommendation: string | null;
  evidence: unknown;
  check_back_on: string | null;
  status: string;
  outcome: string | null;
  superseded_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Validate a resolve_observation call before Postgres sees it: a status of
 * 'superseded' must name what replaces it, and 'resolved' must not carry a
 * superseded_by nobody asked for. Pure, and exported for the test.
 */
export function assertResolveShape(
  status: (typeof STATUSES)[number],
  supersededBy: string | null | undefined,
): void {
  if (status === "superseded" && !supersededBy) {
    throw new ToolError(
      "status 'superseded' requires superseded_by: the id of the " +
        "observation that replaces this one. Call record_observation for " +
        "the new one first, then resolve this one with its id.",
    );
  }
  if (status === "resolved" && supersededBy) {
    throw new ToolError(
      "superseded_by is only meaningful with status 'superseded'. Drop it, " +
        "or use status 'superseded' if this observation is being replaced " +
        "rather than concluded.",
    );
  }
}

export function registerCoachObservations(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "record_observation",
    {
      title: "Record observation",
      description:
        "Record a conclusion reached from the numbers — 'bodyweight is down " +
        "1.8 kg over 28 days during a stated fueling-focused block' — with " +
        "an optional check-back date and the evidence behind it. Use this " +
        "after a session review or any weight/energy/fueling conclusion " +
        "worth revisiting later. evidence should be the relevant slice of " +
        "get_trends' output, frozen at the moment of this call: it is read " +
        "back only for a then-vs-now comparison in resolve_observation, " +
        "never as a live number.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        topic: z
          .enum(TOPICS)
          .describe("bodyweight, fueling, recovery, lift, injury, or other."),
        observation: z
          .string()
          .min(1)
          .max(500)
          .describe("What was concluded, in a sentence or two."),
        recommendation: z
          .string()
          .max(500)
          .optional()
          .describe("What to do about it, if anything."),
        evidence: z
          .record(z.unknown())
          .optional()
          .describe(
            "The numbers behind this conclusion, e.g. a slice of " +
              "get_trends' output. Frozen at write time for a later " +
              "comparison; never treated as a live metric by anything that " +
              "reads it back.",
          ),
        check_back_on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "When to revisit this, YYYY-MM-DD. Omit if this needs no " +
              "follow-up.",
          ),
      },
    },
    (args) =>
      guard(ctx, "record_observation", async () => {
        const rows = must(
          await db.client
            .from("coach_observations")
            .insert({
              user_id: db.ownerId,
              topic: args.topic,
              observation: args.observation,
              recommendation: args.recommendation ?? null,
              evidence: args.evidence ?? {},
              check_back_on: args.check_back_on ?? null,
              status: "open",
            })
            .select("id, topic, observation, check_back_on, created_at"),
          "record observation",
        ) as unknown as ObservationRow[];

        return jsonResult({
          data: { observation: rows[0] ?? null },
          metadata: {
            note:
              "Recorded. When check_back_on arrives, compare the evidence " +
              "here to a fresh get_trends call and resolve_observation it.",
          },
        });
      }),
  );

  server.registerTool(
    "resolve_observation",
    {
      title: "Resolve observation",
      description:
        "Close out an observation: 'resolved' with an outcome, or " +
        "'superseded' by a newer observation's id when the check-back date " +
        "arrived and the picture changed enough to restate rather than " +
        "close. Compare the observation's frozen evidence to a fresh " +
        "get_trends call before deciding which.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe("Observation id, from get_observations."),
        status: z.enum(["resolved", "superseded"]),
        outcome: z
          .string()
          .max(500)
          .optional()
          .describe("What actually happened, in a sentence or two."),
        superseded_by: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Required with status 'superseded': the id of the observation " +
              "that replaces this one.",
          ),
      },
    },
    (args) =>
      guard(ctx, "resolve_observation", async () => {
        assertResolveShape(args.status, args.superseded_by);

        const rows = must(
          await db.client
            .from("coach_observations")
            .update({
              status: args.status,
              outcome: args.outcome ?? null,
              superseded_by: args.superseded_by ?? null,
              resolved_at: new Date().toISOString(),
            })
            .eq("id", args.id)
            .eq("user_id", db.ownerId)
            .select("id, topic, observation, status, outcome, superseded_by"),
          "resolve observation",
        ) as unknown as ObservationRow[];

        if (rows.length === 0) {
          throw new ToolError(
            `No observation with id ${args.id} belongs to this user. Use ` +
              "get_observations to get a valid id.",
          );
        }
        return jsonResult({ data: { observation: rows[0] } });
      }),
  );

  server.registerTool(
    "get_observations",
    {
      title: "Get observations",
      description:
        "The coach's own conclusions, newest first. Pass status to filter " +
        "('open', 'resolved', 'superseded'); omit it for all of them. Use " +
        "this before record_observation, so the same conclusion is not " +
        "written twice, and to find items due for resolve_observation.",
      inputSchema: {
        status: z.enum(STATUSES).optional(),
        n: z.number().int().min(1).max(100).default(25),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      guard(ctx, "get_observations", async () => {
        let q = db.client
          .from("coach_observations")
          .select(
            "id, topic, observation, recommendation, evidence, " +
              "check_back_on, status, outcome, superseded_by, created_at, " +
              "resolved_at",
          )
          .eq("user_id", db.ownerId)
          .order("created_at", { ascending: false })
          .limit(args.n);
        if (args.status) q = q.eq("status", args.status);

        const rows = must(
          await q,
          "observations",
        ) as unknown as ObservationRow[];
        return jsonResult({ count: rows.length, observations: rows });
      }),
  );
}
