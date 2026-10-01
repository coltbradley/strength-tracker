import { describe, expect, it, vi } from "vitest";

const { from, calls, responses } = vi.hoisted(() => ({
  from: vi.fn(),
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  responses: new Map<string, { data: unknown[] | null; error: { message: string; code?: string } | null }>(),
}));

vi.mock("./supabase", () => ({ supabase: { from } }));
vi.mock("./sync", () => ({ outbox: {} }));

function query(table: string) {
  const builder = {
    select(columns: string) { calls.push({ table, method: "select", args: [columns] }); return builder; },
    eq(column: string, value: unknown) { calls.push({ table, method: "eq", args: [column, value] }); return builder; },
    in(column: string, values: readonly string[]) { calls.push({ table, method: "in", args: [column, values] }); return builder; },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(responses.get(table) ?? { data: [], error: null }).then(resolve, reject);
    },
  };
  return builder;
}

from.mockImplementation((table: string) => query(table));

import { getExactSetReceiptIds } from "./data";

const sessionId = "11111111-1111-4111-8111-111111111111";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

describe("getExactSetReceiptIds", () => {
  it("reads exact set and void UUIDs from authenticated owner-scoped queries", async () => {
    calls.length = 0;
    responses.set("sets", { data: [{ id: ids[0] }], error: null });
    responses.set("set_voids", { data: [{ set_id: ids[1] }], error: null });

    await expect(getExactSetReceiptIds(sessionId, ownerId, ids)).resolves.toEqual({
      setIds: new Set([ids[0]]), voidIds: new Set([ids[1]]),
    });

    expect(calls).toContainEqual({ table: "sets", method: "eq", args: ["session_id", sessionId] });
    expect(calls).toContainEqual({ table: "sets", method: "eq", args: ["user_id", ownerId] });
    expect(calls).toContainEqual({ table: "set_voids", method: "eq", args: ["user_id", ownerId] });
    expect(calls).toContainEqual({ table: "set_voids", method: "in", args: ["set_id", ids] });
  });

  it("fails closed when an exact server query fails", async () => {
    responses.set("sets", { data: null, error: { message: "offline", code: "" } });
    responses.set("set_voids", { data: [], error: null });
    await expect(getExactSetReceiptIds(sessionId, ownerId, ids)).rejects.toThrow("offline");
  });
});
