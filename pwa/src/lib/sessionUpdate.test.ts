import { describe, expect, it } from "vitest";
import { guardedUpdate, outboxUpdateResult } from "./sessionUpdate";

interface Step {
  method: string;
  args: unknown[];
}

function client(result: {
  data: { id: string }[] | null;
  error: { message: string; code?: string | null } | null;
  status: number | null;
}) {
  const steps: Step[] = [];
  const chain = {
    update(patch: Record<string, unknown>) {
      steps.push({ method: "update", args: [patch] });
      return chain;
    },
    eq(column: string, value: unknown) {
      steps.push({ method: "eq", args: [column, value] });
      return chain;
    },
    is(column: string, value: null) {
      steps.push({ method: "is", args: [column, value] });
      return chain;
    },
    select(columns: string) {
      steps.push({ method: "select", args: [columns] });
      return Promise.resolve(result);
    },
  };
  return {
    steps,
    from(table: string) {
      steps.push({ method: "from", args: [table] });
      return chain;
    },
  };
}

const open = [
  { method: "is", args: ["ended_at", null] },
  { method: "is", args: ["discarded_at", null] },
];

describe("guardedUpdate", () => {
  it("discards an open session only while it is still open", async () => {
    const db = client({ data: [{ id: "s" }], error: null, status: 200 });
    const result = await guardedUpdate(
      db,
      "sessions",
      "s",
      { discarded_at: "2026-09-23T12:00:00.000Z" },
      { onlyIfOpen: true },
    );
    expect(result.rows).toBe(1);
    expect(db.steps).toEqual(expect.arrayContaining(open));
  });

  it("still discards a finished session from history", async () => {
    const db = client({ data: [{ id: "s" }], error: null, status: 200 });
    await guardedUpdate(db, "sessions", "s", {
      discarded_at: "2026-09-23T12:00:00.000Z",
    });
    expect(db.steps.filter((step) => step.method === "is")).toEqual([
      { method: "is", args: ["discarded_at", null] },
    ]);
  });

  it("finishes only a session that is still open", async () => {
    const db = client({ data: [{ id: "s" }], error: null, status: 200 });
    await guardedUpdate(db, "sessions", "s", {
      ended_at: "2026-09-23T12:00:00.000Z",
      session_rpe: 8,
      bodyweight_kg: null,
      notes: null,
    });
    expect(db.steps).toEqual(expect.arrayContaining(open));
  });

  it("rates a finished session without requiring it to still be open", async () => {
    const db = client({ data: [{ id: "s" }], error: null, status: 200 });
    await guardedUpdate(db, "sessions", "s", { session_rpe: 8 });
    expect(db.steps.filter((step) => step.method === "is")).toEqual([]);
    expect(db.steps.map((step) => step.method)).toContain("select");
  });

  it("reports a zero-row update instead of an empty success", async () => {
    const db = client({ data: [], error: null, status: 200 });
    const result = await guardedUpdate(db, "sessions", "missing", {
      discarded_at: "2026-09-23T12:00:00.000Z",
    });
    expect(result.rows).toBe(0);
    expect(result.error).toBeNull();
    expect(outboxUpdateResult(result)).toEqual({
      message: "update matched no rows",
      code: null,
      status: 409,
    });
  });

  it("keeps a server error instead of calling it a missed row", () => {
    expect(
      outboxUpdateResult({
        error: { message: "permission denied", code: "42501" },
        status: 403,
        rows: 0,
      }),
    ).toEqual({
      message: "permission denied",
      code: "42501",
      status: 403,
    });
  });
});
