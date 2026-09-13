// The window and shape get_checkins asks the database for.
//
// The thing worth pinning is the FILTER that goes out (owner-scoped, bounded
// by days, newest first, capped) rather than any particular row content —
// there is no database here, in the same spirit as get_volume.test.ts and
// lib/protocol.test.ts.
//
//   deno test --allow-env --allow-net tools/get_checkins.test.ts

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import type { RequestContext } from "../lib/errors.ts";
import { registerGetCheckins } from "./get_checkins.ts";

const USER = "00000000-0000-4000-8000-000000000001";

interface Recorded {
  table: string;
  columns: string;
  filters: string[];
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
}

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
  order(column: string, opts: { ascending: boolean }) {
    this.rec.order = { column, ascending: opts.ascending };
    return this;
  }
  limit(n: number) {
    this.rec.limit = n;
    return this;
  }
  then(resolve: (r: { data: unknown[]; error: null }) => unknown) {
    return Promise.resolve({ data: [], error: null }).then(resolve);
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function harness(ownerId: string = USER) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = {
        table,
        columns: "",
        filters: [],
        order: null,
        limit: null,
      };
      calls.push(rec);
      return new FakeQuery(rec);
    },
  };
  const db = { client, ownerId } as unknown as Db;
  const ctx: RequestContext = { requestId: "test-request" };

  let schema: z.ZodTypeAny | null = null;
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | null =
    null;
  const server = {
    registerTool(
      name: string,
      config: { inputSchema: z.ZodRawShape; description?: string },
      fn: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      if (name !== "get_checkins") return;
      schema = z.object(config.inputSchema);
      handler = fn;
      registered.description = config.description ?? "";
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  const registered = { description: "" };

  registerGetCheckins(server, db, ctx);
  if (schema === null || handler === null) {
    throw new Error("get_checkins did not register");
  }
  const parse = schema as z.ZodTypeAny;
  const call = handler as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;

  return {
    calls,
    description: registered.description,
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return await call(parse.parse(args) as Record<string, unknown>);
    },
  };
}

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

Deno.test(
  "scopes by owner, newest first, default 14 days and no explicit limit cap",
  async () => {
    const h = harness();
    const res = await h.run({});
    assertEquals(res.isError, undefined);
    assertEquals(h.calls.length, 1);
    assertEquals(h.calls[0].table, "checkins");
    assertEquals(h.calls[0].filters[0], `eq:user_id=${USER}`);
    const gte = h.calls[0].filters.find((f) =>
      f.startsWith("gte:recorded_at="),
    );
    if (!gte) throw new Error("no gte on recorded_at");
    // Within a minute of "14 days ago" — exact ms would be flaky.
    assertEquals(
      gte.slice("gte:recorded_at=".length, "gte:recorded_at=".length + 10),
      daysAgoIso(14),
    );
    assertEquals(h.calls[0].order, { column: "recorded_at", ascending: false });
  },
);

Deno.test("days narrows the window", async () => {
  const h = harness();
  await h.run({ days: 3 });
  const gte = h.calls[0].filters.find((f) => f.startsWith("gte:recorded_at="))!;
  assertEquals(
    gte.slice("gte:recorded_at=".length, "gte:recorded_at=".length + 10),
    daysAgoIso(3),
  );
});

// A value outside the schema's bounds is refused at the SCHEMA boundary
// (zod), the same layer the MCP SDK validates arguments against before a
// handler ever runs — never silently clamped, which would answer a "give me
// a year" request with fourteen days and no way to tell.
Deno.test("days is capped at 90", async () => {
  const h = harness();
  await assertRejects(() => h.run({ days: 400 }));
});

Deno.test("limit defaults sensibly and is capped", async () => {
  const h = harness();
  await h.run({});
  // A default that will not blow out a turn's context on a chatty user.
  if (h.calls[0].limit === null || h.calls[0].limit > 100) {
    throw new Error(`unexpected default limit: ${h.calls[0].limit}`);
  }

  const capped = harness();
  await assertRejects(() => capped.run({ limit: 100000 }));
});

Deno.test(
  "returns note, energy, kind, recorded_at and session_id",
  async () => {
    const h = harness();
    await h.run({});
    for (const col of ["note", "energy", "kind", "recorded_at", "session_id"]) {
      assertStringIncludes(h.calls[0].columns, col);
    }
  },
);

Deno.test(
  "the description warns that notes are data, not instructions",
  async () => {
    const h = harness();
    const d = h.description.toLowerCase();
    assertStringIncludes(d, "not a trend");
    assertStringIncludes(d, "data");
    assertStringIncludes(d, "instructions");
  },
);

Deno.test("is read-only", async () => {
  let readOnly: boolean | undefined;
  const server = {
    registerTool(
      name: string,
      config: { annotations?: { readOnlyHint?: boolean } },
      _fn: unknown,
    ) {
      if (name === "get_checkins") readOnly = config.annotations?.readOnlyHint;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  const db = { client: { from: () => ({}) }, ownerId: USER } as unknown as Db;
  registerGetCheckins(server, db, { requestId: "t" });
  assertEquals(readOnly, true);
});
