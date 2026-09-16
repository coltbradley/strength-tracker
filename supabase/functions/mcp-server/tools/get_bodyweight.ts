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
 * Bodyweight over time, from BOTH sources v_bodyweight unions: the standalone
 * log (a day with no training) and sessions.bodyweight_kg (captured at
 * Finish). Points plus 7- and 28-day means with counts, the same shape
 * get_trends reports for the same numbers, so a client that wants the raw
 * series and a client that wants the rollup agree on what the rollup means.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface BodyweightRow {
  measured_at: string;
  weight_kg: number;
  source: "log" | "session";
  source_id: string;
}

export function registerGetBodyweight(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_bodyweight",
    {
      title: "Get bodyweight",
      description:
        "Bodyweight measurements, newest first, from both the standalone " +
        "weigh-in log and sessions where it was captured at Finish (source " +
        "tells them apart). Plus 7-day and 28-day means, each with its own " +
        "count since a mean over one point is not the same claim as a mean " +
        "over ten. from/to bound by local date (YYYY-MM-DD); omit both for " +
        "the default 90-day window.",
      inputSchema: {
        from: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe(
            "First date (their local calendar), YYYY-MM-DD. Replaces the " +
              "default window when given, alone or with to.",
          ),
        to: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe(
            "Last date, YYYY-MM-DD. Replaces the default window when " +
              "given, alone or with from.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      guard(ctx, "get_bodyweight", async () => {
        if (args.from && args.to && args.from > args.to) {
          throw new ToolError("from must be on or before to.");
        }

        let q = db.client
          .from("v_bodyweight")
          .select("measured_at, weight_kg, source, source_id")
          .eq("user_id", db.ownerId);

        let since: string | undefined;
        if (args.from || args.to) {
          if (args.from) q = q.gte("measured_at", args.from);
          if (args.to) q = q.lte("measured_at", args.to);
        } else {
          since = new Date(Date.now() - 90 * 86_400_000).toISOString();
          q = q.gte("measured_at", since);
        }

        const rows = must(
          await q.order("measured_at", { ascending: false }),
          "bodyweight",
        ) as unknown as BodyweightRow[];

        const meanOver = (days: number) => {
          const cutoff = Date.now() - days * 86_400_000;
          const inWindow = rows.filter(
            (r) => Date.parse(r.measured_at) >= cutoff,
          );
          if (inWindow.length === 0) return { mean_kg: null, n: 0 };
          const sum = inWindow.reduce((acc, r) => acc + r.weight_kg, 0);
          return {
            mean_kg: Math.round((sum / inWindow.length) * 100) / 100,
            n: inWindow.length,
          };
        };

        return jsonResult({
          data: {
            points: rows,
            latest_kg: rows[0]?.weight_kg ?? null,
            mean_7d: meanOver(7),
            mean_28d: meanOver(28),
          },
          metadata: {
            ...(since ? { since } : { from: args.from, to: args.to }),
            count: rows.length,
          },
        });
      }),
  );
}
