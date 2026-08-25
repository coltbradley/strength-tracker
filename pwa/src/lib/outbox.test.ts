import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { createOutbox, type OutboxTransport } from "./outbox";
import { getDb, resetDbForTests } from "./db";
import type { SessionInsert, SetInsert } from "./types";

interface Call {
  kind: "insert" | "update";
  table: string;
  payload: unknown;
}

function makeTransport() {
  const calls: Call[] = [];
  const failures: string[] = []; // consumed FIFO; empty = succeed
  const transport: OutboxTransport = {
    async insert(table, payload) {
      calls.push({ kind: "insert", table, payload });
      return failures.shift() ?? null;
    },
    async update(table, id, patch) {
      calls.push({ kind: "update", table, payload: { id, patch } });
      return failures.shift() ?? null;
    },
  };
  return { calls, failures, transport };
}

const session: SessionInsert = {
  id: "11111111-1111-4111-8111-111111111111",
  planned_workout_id: null,
  started_at: "2026-08-25T10:00:00.000Z",
};

function makeSet(id: string, setIndex: number): SetInsert {
  return {
    id,
    session_id: session.id,
    exercise_id: "Barbell_Squat",
    prescription_id: null,
    set_index: setIndex,
    set_type: "working",
    load_kg: 100,
    reps: 5,
    performed_at: `2026-08-25T10:0${setIndex}:00.000Z`,
  };
}

const setA = makeSet("22222222-2222-4222-8222-222222222222", 0);
const setB = makeSet("33333333-3333-4333-8333-333333333333", 1);

describe("outbox", () => {
  let online: boolean;

  beforeEach(() => {
    // fresh IndexedDB per test
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    online = false; // hold auto-flush during enqueue so tests drive flush()
  });

  function build(transport: OutboxTransport) {
    return createOutbox({ getDb, transport, isOnline: () => online });
  }

  it("flushes queued writes in enqueue order", async () => {
    const { calls, transport } = makeTransport();
    const outbox = build(transport);

    await outbox.enqueue({
      kind: "insert",
      table: "sessions",
      payload: session,
    });
    await outbox.enqueue({ kind: "insert", table: "sets", payload: setA });
    await outbox.enqueue({ kind: "insert", table: "sets", payload: setB });
    await outbox.enqueue({
      kind: "update",
      table: "sessions",
      id: session.id,
      patch: {
        ended_at: "2026-08-25T11:00:00.000Z",
        session_rpe: 8,
        bodyweight_kg: null,
        notes: null,
      },
    });

    expect(outbox.getStatus().pending).toBe(4);
    expect(calls).toHaveLength(0); // offline: nothing pushed yet

    online = true;
    await outbox.flush();

    expect(calls.map((c) => `${c.kind}:${c.table}`)).toEqual([
      "insert:sessions",
      "insert:sets",
      "insert:sets",
      "update:sessions",
    ]);
    expect(calls[1].payload).toEqual(setA);
    expect(calls[2].payload).toEqual(setB);
    expect(outbox.getStatus()).toEqual({
      pending: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("replays after a failure without dropping or duplicating (idempotent upsert)", async () => {
    // scripted results, consumed per call: null = success, string = error
    const scripted: Array<string | null> = [null, "network down"];
    const calls: Call[] = [];
    const t2: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ kind: "insert", table, payload });
        return scripted.length > 0 ? (scripted.shift() ?? null) : null;
      },
      async update(table, id, patch) {
        calls.push({ kind: "update", table, payload: { id, patch } });
        return scripted.length > 0 ? (scripted.shift() ?? null) : null;
      },
    };
    const outbox2 = createOutbox({
      getDb,
      transport: t2,
      isOnline: () => online,
    });

    await outbox2.enqueue({
      kind: "insert",
      table: "sessions",
      payload: session,
    });
    await outbox2.enqueue({ kind: "insert", table: "sets", payload: setA });
    await outbox2.flush(); // drain enqueue-triggered flushes while offline
    expect(calls).toHaveLength(0); // offline while enqueueing

    online = true;
    await outbox2.flush();

    // session pushed and removed; setA failed and retained
    expect(calls.map((c) => `${c.kind}:${c.table}`)).toEqual([
      "insert:sessions",
      "insert:sets",
    ]);
    expect(outbox2.getStatus().pending).toBe(1);
    expect(outbox2.getStatus().state).toBe("error");
    expect(outbox2.getStatus().lastError).toBe("network down");

    // retry: the SAME payload is upserted again (ignoreDuplicates makes the
    // replay a no-op server-side if the first attempt actually landed)
    await outbox2.flush();
    const setInserts = calls.filter((c) => c.table === "sets");
    expect(setInserts).toHaveLength(2);
    expect(setInserts[0].payload).toEqual(setInserts[1].payload);
    expect(setInserts[1].payload).toEqual(setA);
    // session insert was NOT re-sent
    expect(calls.filter((c) => c.table === "sessions")).toHaveLength(1);
    expect(outbox2.getStatus()).toEqual({
      pending: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("failed items keep retry count and last error, never dropped", async () => {
    const { failures, transport } = makeTransport();
    const outbox = build(transport);

    await outbox.enqueue({ kind: "insert", table: "sets", payload: setA });
    await outbox.flush(); // drain enqueue-triggered flushes while offline

    online = true;
    failures.push("boom 1");
    await outbox.flush();
    failures.push("boom 2");
    await outbox.flush();

    expect(outbox.getStatus().pending).toBe(1);
    expect(outbox.getStatus().lastError).toBe("boom 2");

    const db = await getDb();
    const items = await db.getAll("outbox");
    expect(items).toHaveLength(1);
    expect(items[0].retries).toBe(2);
    expect(items[0].last_error).toBe("boom 2");
    expect(items[0].op).toEqual({
      kind: "insert",
      table: "sets",
      payload: setA,
    });
  });

  it("pendingSets returns queued set inserts for a session", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    await outbox.enqueue({
      kind: "insert",
      table: "sessions",
      payload: session,
    });
    await outbox.enqueue({ kind: "insert", table: "sets", payload: setA });
    await outbox.enqueue({ kind: "insert", table: "sets", payload: setB });

    const pending = await outbox.pendingSets(session.id);
    expect(pending).toEqual([setA, setB]);
    expect(await outbox.pendingSets("other-session")).toEqual([]);
  });
});
