// A fake PostgREST client for tool tests. Records what each query asked for
// (table, columns, filters, order, limit) and resolves with fixture rows per
// table. There is no database here, in the spirit of get_volume.test.ts.
import { z } from "zod";
import type { Db } from "./db.ts";
import type { RequestContext } from "./errors.ts";

export const TEST_USER = "00000000-0000-4000-8000-000000000001";

export interface Recorded {
  table: string;
  columns: string;
  filters: string[];
  order: { column: string; ascending: boolean }[];
  limit: number | null;
  /** The payload passed to .insert(), if this call chain used it. */
  insert?: unknown;
  /** The patch passed to .update(), if this call chain used it. */
  update?: unknown;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

class FakeQuery {
  constructor(
    private readonly rec: Recorded,
    private readonly rows: unknown[],
  ) {}
  select(columns: string) {
    this.rec.columns = columns;
    return this;
  }
  /** Records the payload; resolves with the table's fixture rows, exactly as
   *  a real `.insert(row).select(cols)` returns the inserted row(s) — the
   *  fixture is what the test controls the "returned" row to look like. */
  insert(row: unknown) {
    this.rec.insert = row;
    return this;
  }
  /** Same shape as insert(): records the patch, resolves with fixture rows. */
  update(patch: unknown) {
    this.rec.update = patch;
    return this;
  }
  private f(op: string, column: string, value: unknown) {
    this.rec.filters.push(
      `${op}:${column}=${Array.isArray(value) ? value.join(",") : value}`,
    );
    return this;
  }
  eq(c: string, v: unknown) {
    return this.f("eq", c, v);
  }
  is(c: string, v: unknown) {
    return this.f("is", c, v);
  }
  gte(c: string, v: unknown) {
    return this.f("gte", c, v);
  }
  lte(c: string, v: unknown) {
    return this.f("lte", c, v);
  }
  in(c: string, v: unknown[]) {
    return this.f("in", c, v);
  }
  overlaps(c: string, v: unknown[]) {
    return this.f("overlaps", c, v);
  }
  order(column: string, opts: { ascending: boolean }) {
    this.rec.order.push({ column, ascending: opts.ascending });
    return this;
  }
  limit(n: number) {
    this.rec.limit = n;
    return this;
  }
  then<R>(resolve: (r: { data: unknown[]; error: null }) => R) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}

// deno-lint-ignore no-explicit-any
type Register = (server: any, db: Db, ctx: RequestContext) => void;

export function toolHarness(
  register: Register,
  name: string,
  fixtures: Record<string, unknown[]> = {},
  ownerId: string = TEST_USER,
) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = {
        table,
        columns: "",
        filters: [],
        order: [],
        limit: null,
      };
      calls.push(rec);
      return new FakeQuery(rec, fixtures[table] ?? []);
    },
  };
  const db = { client, ownerId } as unknown as Db;
  let schema: z.ZodTypeAny | null = null;
  let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | null =
    null;
  const meta = { description: "", readOnly: undefined as boolean | undefined };
  const server = {
    registerTool(
      toolName: string,
      config: {
        inputSchema: z.ZodRawShape;
        description?: string;
        annotations?: { readOnlyHint?: boolean };
      },
      fn: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      if (toolName !== name) return;
      schema = z.object(config.inputSchema);
      handler = fn;
      meta.description = config.description ?? "";
      meta.readOnly = config.annotations?.readOnlyHint;
    },
  };
  register(server, db, { requestId: "test-request" });
  if (schema === null || handler === null)
    throw new Error(`${name} did not register`);
  const parse = schema as z.ZodTypeAny;
  const call = handler as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  return {
    calls,
    meta,
    run: async (args: Record<string, unknown>) =>
      await call(parse.parse(args) as Record<string, unknown>),
  };
}

/** The JSON body of a tool result (jsonResult puts it in the last text part). */
// deno-lint-ignore no-explicit-any
export function payload(res: ToolResult): any {
  return JSON.parse(res.content[res.content.length - 1].text);
}
