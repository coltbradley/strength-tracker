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
  /** The [from, to] passed to .range(), if the chain paged. */
  range?: [number, number];
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

export interface FakeError {
  code?: string;
  message: string;
  hint?: string;
  details?: string;
}

export interface HarnessOptions {
  /** Resolve EVERY query on this table with a PostgREST-shaped error. */
  errors?: Record<string, FakeError>;
  /** Handlers for `client.rpc(name, args)`; default resolves `{data:null}`. */
  rpc?: Record<
    string,
    (args: unknown) => { data?: unknown; error?: FakeError | null }
  >;
}

class FakeQuery {
  constructor(
    private readonly rec: Recorded,
    private readonly rows: unknown[],
    private readonly error: FakeError | null = null,
  ) {}
  upsert(row: unknown, _opts?: unknown) {
    this.rec.insert = row;
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this;
  }
  range(from: number, to: number) {
    this.rec.range = [from, to];
    return this;
  }
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
    // Like the real thing, narrow by the list when the fixture row carries
    // the column. Rows without it are left alone, so older fixtures that
    // never modelled the join column behave as before.
    this.inFilters.push([c, v]);
    return this.f("in", c, v);
  }
  gt(c: string, v: unknown) {
    return this.f("gt", c, v);
  }
  lt(c: string, v: unknown) {
    return this.f("lt", c, v);
  }
  neq(c: string, v: unknown) {
    return this.f("neq", c, v);
  }
  not(c: string, op: string, v: unknown) {
    return this.f(`not.${op}`, c, v);
  }
  or(expr: string) {
    return this.f("or", "", expr);
  }
  contains(c: string, v: unknown[]) {
    return this.f("contains", c, v);
  }
  overlaps(c: string, v: unknown[]) {
    return this.f("overlaps", c, v);
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.rec.order.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.rec.limit = n;
    return this;
  }
  /** `.single()` resolves with the first fixture row rather than the array. */
  single() {
    this.one = true;
    return this;
  }
  private one = false;
  private inFilters: [string, unknown[]][] = [];
  then<R>(resolve: (r: { data: unknown; error: FakeError | null }) => R) {
    if (this.error) {
      return Promise.resolve({ data: null, error: this.error }).then(resolve);
    }
    let rows = this.rows;
    for (const [c, v] of this.inFilters) {
      rows = rows.filter((r) => {
        const val = (r as Record<string, unknown>)[c];
        return val === undefined || v.includes(val);
      });
    }
    if (this.rec.range) {
      rows = rows.slice(this.rec.range[0], this.rec.range[1] + 1);
    }
    return Promise.resolve({
      data: this.one ? rows[0] ?? null : rows,
      error: null,
    }).then(resolve);
  }
}

// deno-lint-ignore no-explicit-any
type Register = (server: any, db: Db, ctx: RequestContext) => void;

export function toolHarness(
  register: Register,
  name: string,
  fixtures: Record<string, unknown[]> = {},
  ownerId: string = TEST_USER,
  ctx: RequestContext = { requestId: "test-request" },
  opts: HarnessOptions = {},
) {
  const calls: Recorded[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];
  const client = {
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      const r = opts.rpc?.[name]?.(args) ?? { data: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    from(table: string) {
      const rec: Recorded = {
        table,
        columns: "",
        filters: [],
        order: [],
        limit: null,
      };
      calls.push(rec);
      return new FakeQuery(
        rec,
        fixtures[table] ?? [],
        opts.errors?.[table] ?? null,
      );
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
  register(server, db, ctx);
  if (schema === null || handler === null)
    throw new Error(`${name} did not register`);
  const parse = schema as z.ZodTypeAny;
  const call = handler as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  return {
    calls,
    rpcCalls,
    db,
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

/** A fake Db alone, for helpers in lib/ that take a Db rather than a tool. */
export function fakeDb(
  fixtures: Record<string, unknown[]> = {},
  opts: HarnessOptions = {},
) {
  const t = toolHarness(
    (server, _db, _ctx) => {
      server.registerTool("noop", { inputSchema: {} }, () => ({}));
    },
    "noop",
    fixtures,
    TEST_USER,
    undefined,
    opts,
  );
  return { db: t.db, calls: t.calls };
}
