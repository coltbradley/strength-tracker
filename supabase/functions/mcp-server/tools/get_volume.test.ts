// The window get_volume actually asks the database for.
//
// The tool computes a floor on `week_start` and hands it to PostgREST, so the
// thing worth pinning is not the rows that come back (there is no database
// here) but the FILTER that goes out: the coach asking "the last four weeks"
// should narrow the query, not read a whole history and throw most of it away,
// and a caller who names an absolute `since` must not have it silently clipped
// back to the twelve-week default that used to live in the schema.
//
// No port, no network and no Supabase: the client is a recorder that captures
// the chained calls, in the same spirit as lib/protocol.test.ts calling the
// handler directly.
//
//   deno test --allow-env --allow-net tools/get_volume.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import type { RequestContext } from "../lib/errors.ts";
import { registerGetVolume } from "./get_volume.ts";

const USER = "00000000-0000-4000-8000-000000000001";

/** One PostgREST call, as the tool built it. */
interface Recorded {
  table: string;
  columns: string;
  /** `op:column=value`, in the order the tool chained them. */
  filters: string[];
  limit: number | null;
}

/** The chainable, awaitable stand-in for a PostgREST query builder. */
class FakeQuery {
  constructor(private readonly rec: Recorded) {}
  select(columns: string) {
    this.rec.columns = columns;
    return this;
  }
  eq(column: string, value: unknown) {
    this.rec.filters.push(`eq:${column}=${value}`);
    return this;
  }
  gte(column: string, value: unknown) {
    this.rec.filters.push(`gte:${column}=${value}`);
    return this;
  }
  order(_column: string, _opts: unknown) {
    return this;
  }
  limit(n: number) {
    this.rec.limit = n;
    return this;
  }
  // Awaited by must(); a query that was never awaited is a query the tool
  // forgot to run, and would show up as a missing recording.
  then(resolve: (r: { data: unknown[]; error: null }) => unknown) {
    return Promise.resolve({ data: [], error: null }).then(resolve);
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/**
 * Register the tool against a recorder and hand back a caller. Arguments are
 * parsed through the tool's OWN inputSchema first, so the zod layer (which is
 * where `weeks` stopped carrying a default) is part of what is under test
 * rather than something the test quietly bypasses.
 */
function harness() {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = { table, columns: "", filters: [], limit: null };
      calls.push(rec);
      return new FakeQuery(rec);
    },
  };
  const db = { client, ownerId: USER } as unknown as Db;
  const ctx: RequestContext = { requestId: "test-request" };

  let schema: z.ZodTypeAny | null = null;
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | null =
    null;
  const server = {
    registerTool(
      name: string,
      config: { inputSchema: z.ZodRawShape },
      fn: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      if (name !== "get_volume") return;
      schema = z.object(config.inputSchema);
      handler = fn;
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  registerGetVolume(server, db, ctx);
  if (schema === null || handler === null) {
    throw new Error("get_volume did not register");
  }
  const parse = schema as z.ZodTypeAny;
  const call = handler as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;

  return {
    calls,
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return await call(parse.parse(args) as Record<string, unknown>);
    },
  };
}

/** The floor the tool computes for a lookback of n weeks. */
function weeksAgo(n: number): string {
  return new Date(Date.now() - n * 7 * 86_400_000).toISOString().slice(0, 10);
}

function gteOn(rec: Recorded, column: string): string {
  const hit = rec.filters.find((f) => f.startsWith(`gte:${column}=`));
  if (hit === undefined) {
    throw new Error(`no gte on ${column}; filters were ${rec.filters}`);
  }
  return hit.slice(`gte:${column}=`.length);
}

function payload(res: ToolResult): {
  metadata: { since: string; count: number };
} {
  return JSON.parse(res.content[res.content.length - 1].text);
}

Deno.test("no since: the twelve-week default, unchanged", async () => {
  // The behaviour every existing caller has. `since` is additive or it is a
  // silent change to every volume answer already being given.
  const h = harness();
  const res = await h.run({});
  assertEquals(res.isError, undefined);
  assertEquals(h.calls.length, 1);
  assertEquals(h.calls[0].table, "v_weekly_volume");
  assertEquals(h.calls[0].filters[0], `eq:user_id=${USER}`);
  assertEquals(gteOn(h.calls[0], "week_start"), weeksAgo(12));
  assertEquals(h.calls[0].limit, 1000);
  assertEquals(payload(res).metadata.since, weeksAgo(12));
});

Deno.test("no since: an explicit weeks still sets the floor", async () => {
  const h = harness();
  await h.run({ weeks: 4 });
  assertEquals(gteOn(h.calls[0], "week_start"), weeksAgo(4));
});

Deno.test("since narrows the query instead of the answer", async () => {
  // The point of the parameter: the filter goes to Postgres. A tool that
  // fetched everything and sliced it here would pass a rows assertion and
  // still be the bug.
  const h = harness();
  const res = await h.run({ since: "2026-08-03" });
  assertEquals(gteOn(h.calls[0], "week_start"), "2026-08-03");
  assertEquals(payload(res).metadata.since, "2026-08-03");
});

Deno.test("a since older than twelve weeks is not clipped back", async () => {
  // The reason `weeks` lost its zod default. With one, this asked for January
  // and got twelve weeks, with nothing in the answer to say so.
  const h = harness();
  await h.run({ since: "2026-01-01" });
  assertEquals(gteOn(h.calls[0], "week_start"), "2026-01-01");
});

Deno.test("both bounds: the later one wins", async () => {
  // They are floors on the same column, so naming both asks for both.
  const h = harness();
  await h.run({ since: "2026-01-01", weeks: 2 });
  assertEquals(gteOn(h.calls[0], "week_start"), weeksAgo(2));

  const h2 = harness();
  await h2.run({ since: "2099-01-01", weeks: 52 });
  assertEquals(gteOn(h2.calls[0], "week_start"), "2099-01-01");
});

Deno.test("exercise_id still narrows alongside a since", async () => {
  const h = harness();
  await h.run({ since: "2026-08-03", exercise_id: "Barbell_Squat" });
  assertEquals(
    h.calls[0].filters.includes("eq:exercise_id=Barbell_Squat"),
    true,
  );
});

Deno.test(
  "a malformed since is refused by name, and asks for nothing",
  async () => {
    // assertIsoDate throws a ToolError, which guard() turns into a message the
    // model can act on. The alternative is an opaque Postgres 400 arriving as
    // "Unexpected server error", which tells the caller nothing about which
    // argument to fix.
    for (const bad of ["2026-02-30", "not-a-date", "08/03/2026", "2026-8-3"]) {
      const h = harness();
      const res = await h.run({ since: bad });
      assertEquals(res.isError, true, `accepted ${bad}`);
      assertStringIncludes(res.content[0].text, "since");
      assertStringIncludes(res.content[0].text, bad);
      // And it fails BEFORE the query: a bad date must not become a filter.
      assertEquals(h.calls.length, 0);
    }
  },
);
