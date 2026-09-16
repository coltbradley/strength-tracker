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
import { CHECKIN_READING_RULES } from "./get_checkins.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export function registerGetCheckinBuckets(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_checkin_buckets",
    {
      title: "Get check-in patterns",
      description:
        "Check-ins summarised per day and time of day (morning, midday, " +
        "evening) in the lifter's timezone: how many check-ins, how many had " +
        "energy, mean/min/max energy, and the tags seen. Use it to see a " +
        "pattern across weeks without reading every row; use get_checkins for " +
        "the notes. Every mean comes with its count. " +
        CHECKIN_READING_RULES,
      inputSchema: {
        from: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe(
            "First local date, YYYY-MM-DD. Default 27 days before `to`.",
          ),
        to: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe(
            "Last local date, YYYY-MM-DD. Default: the latest possible local date today (tomorrow in UTC).",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      guard(ctx, "get_checkin_buckets", async () => {
        // Default `to` to tomorrow in UTC to capture the latest local date for any timezone.
        // No timezone is more than +14h from UTC, so tomorrow UTC is always >= today everywhere.
        const to = args.to ?? isoDaysAgo(-1);
        const from =
          args.from ??
          new Date(Date.parse(to) - 27 * 86_400_000).toISOString().slice(0, 10);
        const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
        if (span < 0 || span > 366) {
          // ToolError: a validation message for the caller, not a Sentry report.
          throw new ToolError(
            "from must be on or before to, and the range at most a year.",
          );
        }
        const rows = must(
          await db.client
            .from("v_checkin_buckets")
            .select(
              "local_date, bucket, checkins, energy_n, energy_mean, energy_min, energy_max, tags",
            )
            .eq("user_id", db.ownerId)
            .gte("local_date", from)
            .lte("local_date", to)
            .order("local_date", { ascending: true })
            .order("bucket", { ascending: true }),
          "checkin buckets",
        );
        return jsonResult({
          data: { buckets: rows },
          metadata: { from, to, count: rows.length },
        });
      }),
  );
}
