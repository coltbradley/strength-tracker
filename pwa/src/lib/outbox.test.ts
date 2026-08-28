import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutbox,
  type OutboxTransport,
  type TransportError,
} from "./outbox";
import { getDb, resetDbForTests } from "./db";
import type { SessionInsert, SetInsert } from "./types";

interface Call {
  kind: "insert" | "update";
  table: string;
  payload: unknown;
}

// Transport whose results are scripted per call (FIFO). null = success,
// TransportError = failure. Empty script = every call succeeds.
function makeTransport(script: Array<TransportError | null> = []) {
  const calls: Call[] = [];
  const next = (): TransportError | null => {
    const v = script.shift();
    return v === undefined ? null : v;
  };
  const transport: OutboxTransport = {
    async insert(table, payload) {
      calls.push({ kind: "insert", table, payload });
      return next();
    },
    async update(table, id, patch) {
      calls.push({ kind: "update", table, payload: { id, patch } });
      return next();
    },
  };
  return { calls, script, transport };
}

const netErr = (msg = "network down"): TransportError => ({
  message: msg,
  code: null,
  status: null,
});
const rlsErr: TransportError = {
  message: "permission denied for table sets",
  code: "42501",
  status: 403,
};
const fkErr: TransportError = {
  message: "violates foreign key constraint sets_prescription_id_fkey",
  code: "23503",
  status: 409,
};
const authErr: TransportError = {
  message: "JWT expired",
  code: null,
  status: 401,
};

const session: SessionInsert = {
  id: "11111111-1111-4111-8111-111111111111",
  planned_workout_id: null,
  started_at: "2026-08-25T10:00:00.000Z",
};

function makeSet(
  id: string,
  setIndex: number,
  prescriptionId: string | null = null,
): SetInsert {
  return {
    id,
    session_id: session.id,
    exercise_id: "Barbell_Squat",
    prescription_id: prescriptionId,
    set_index: setIndex,
    set_type: "working",
    load_kg: 100,
    reps: 5,
    performed_at: `2026-08-25T10:0${setIndex}:00.000Z`,
    rest_seconds_actual: setIndex === 0 ? null : 150,
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

  /** enqueue while offline, then drain the enqueue-triggered flushes */
  async function seed(
    outbox: ReturnType<typeof build>,
    ops: Array<Parameters<ReturnType<typeof build>["enqueue"]>[0]>,
  ) {
    for (const op of ops) await outbox.enqueue(op);
    await outbox.flush();
  }

  it("flushes queued writes in enqueue order", async () => {
    const { calls, transport } = makeTransport();
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "sessions", payload: session },
      { kind: "insert", table: "sets", payload: setA },
      { kind: "insert", table: "sets", payload: setB },
      {
        kind: "update",
        table: "sessions",
        id: session.id,
        patch: {
          ended_at: "2026-08-25T11:00:00.000Z",
          session_rpe: 8,
          bodyweight_kg: null,
          notes: null,
        },
      },
    ]);

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
      dead: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("replays after a network failure without dropping or duplicating (idempotent upsert)", async () => {
    // first call (session) succeeds, second (setA) fails with a network error
    const { calls, transport } = makeTransport([null, netErr()]);
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "sessions", payload: session },
      { kind: "insert", table: "sets", payload: setA },
    ]);
    expect(calls).toHaveLength(0);

    online = true;
    await outbox.flush();

    // session pushed and removed; setA failed and retained as pending
    expect(calls.map((c) => `${c.kind}:${c.table}`)).toEqual([
      "insert:sessions",
      "insert:sets",
    ]);
    expect(outbox.getStatus().pending).toBe(1);
    expect(outbox.getStatus().state).toBe("error");
    expect(outbox.getStatus().lastError).toBe("network down");

    // retry: the SAME payload is upserted again (ignoreDuplicates makes the
    // replay a no-op server-side if the first attempt actually landed)
    await outbox.flush();
    const setInserts = calls.filter((c) => c.table === "sets");
    expect(setInserts).toHaveLength(2);
    expect(setInserts[0].payload).toEqual(setInserts[1].payload);
    expect(setInserts[1].payload).toEqual(setA);
    // session insert was NOT re-sent
    expect(calls.filter((c) => c.table === "sessions")).toHaveLength(1);
    expect(outbox.getStatus()).toEqual({
      pending: 0,
      dead: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("network-failed items keep retry count and last error, never dropped", async () => {
    const { script, transport } = makeTransport();
    const outbox = build(transport);

    await seed(outbox, [{ kind: "insert", table: "sets", payload: setA }]);

    online = true;
    script.push(netErr("boom 1"));
    await outbox.flush();
    script.push(netErr("boom 2"));
    await outbox.flush();

    expect(outbox.getStatus().pending).toBe(1);
    expect(outbox.getStatus().dead).toBe(0);
    expect(outbox.getStatus().lastError).toBe("boom 2");

    const db = await getDb();
    const items = await db.getAll("outbox");
    expect(items).toHaveLength(1);
    expect(items[0].retries).toBe(2);
    expect(items[0].last_error).toBe("boom 2");
    expect(items[0].status).toBe("pending");
    expect(items[0].op).toEqual({
      kind: "insert",
      table: "sets",
      payload: setA,
    });
  });

  it("dead-letters constraint/RLS failures and keeps flushing past them", async () => {
    // setA hits RLS (permanent), setB succeeds
    const { calls, transport } = makeTransport([rlsErr, null]);
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "sets", payload: setA },
      { kind: "insert", table: "sets", payload: setB },
    ]);

    online = true;
    await outbox.flush();

    // both were attempted — the dead item did not block the queue
    expect(calls.map((c) => c.table)).toEqual(["sets", "sets"]);
    expect(calls[1].payload).toEqual(setB);

    const status = outbox.getStatus();
    expect(status.pending).toBe(0);
    expect(status.dead).toBe(1);
    expect(status.state).toBe("idle");

    // the dead item is kept in IndexedDB with its error, not dropped
    const db = await getDb();
    const items = await db.getAll("outbox");
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("dead");
    expect(items[0].last_error).toBe(rlsErr.message);
    expect(items[0].op).toEqual({
      kind: "insert",
      table: "sets",
      payload: setA,
    });

    // subsequent flushes skip it entirely
    await outbox.flush();
    expect(calls).toHaveLength(2);

    // ...but it still shows up in pendingSets (the UI must reflect it)
    expect(await outbox.pendingSets(session.id)).toEqual([setA]);
  });

  it("retryDead re-queues dead items and flushes them", async () => {
    const { calls, transport } = makeTransport([rlsErr]);
    const outbox = build(transport);

    await seed(outbox, [{ kind: "insert", table: "sets", payload: setA }]);
    online = true;
    await outbox.flush();
    expect(outbox.getStatus().dead).toBe(1);

    // e.g. the RLS problem got fixed server-side; user taps "retry failed"
    await outbox.retryDead();

    expect(calls.filter((c) => c.table === "sets")).toHaveLength(2);
    expect(outbox.getStatus()).toEqual({
      pending: 0,
      dead: 0,
      state: "idle",
      lastError: null,
    });
    const db = await getDb();
    expect(await db.count("outbox")).toBe(0);
  });

  it("23503 on a sets insert nulls prescription_id and retries once — the set survives", async () => {
    const rxSet = makeSet(
      "44444444-4444-4444-8444-444444444444",
      0,
      "99999999-9999-4999-8999-999999999999",
    );
    const { calls, transport } = makeTransport([fkErr]); // fails once, then succeeds
    const outbox = build(transport);

    await seed(outbox, [{ kind: "insert", table: "sets", payload: rxSet }]);

    online = true;
    await outbox.flush();

    expect(calls).toHaveLength(2);
    // first attempt carried the prescription link
    expect((calls[0].payload as SetInsert).prescription_id).toBe(
      rxSet.prescription_id,
    );
    // retry dropped the link but kept everything else
    expect(calls[1].payload).toEqual({ ...rxSet, prescription_id: null });
    expect(outbox.getStatus()).toEqual({
      pending: 0,
      dead: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("a second FK failure after nulling prescription_id dead-letters instead of looping", async () => {
    const rxSet = makeSet(
      "44444444-4444-4444-8444-444444444444",
      0,
      "99999999-9999-4999-8999-999999999999",
    );
    // FK error twice: e.g. the exercise row is the actual missing reference
    const { calls, transport } = makeTransport([fkErr, fkErr]);
    const outbox = build(transport);

    await seed(outbox, [{ kind: "insert", table: "sets", payload: rxSet }]);

    online = true;
    await outbox.flush();

    expect(calls).toHaveLength(2); // no infinite retry loop
    expect(outbox.getStatus().pending).toBe(0);
    expect(outbox.getStatus().dead).toBe(1);
  });

  it("401 triggers one auth refresh then retries; a working refresh unblocks the item", async () => {
    const { calls, transport } = makeTransport([authErr]);
    const refreshAuth = vi.fn(async () => true);
    const outbox = build({ ...transport, refreshAuth });

    await seed(outbox, [{ kind: "insert", table: "sets", payload: setA }]);

    online = true;
    await outbox.flush();

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2); // failed once, retried after refresh
    expect(outbox.getStatus()).toEqual({
      pending: 0,
      dead: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("401 with a failed refresh parks the item as dead", async () => {
    const { calls, transport } = makeTransport([authErr]);
    const refreshAuth = vi.fn(async () => false); // signed out for real
    const outbox = build({ ...transport, refreshAuth });

    await seed(outbox, [{ kind: "insert", table: "sets", payload: setA }]);

    online = true;
    await outbox.flush();

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(outbox.getStatus().dead).toBe(1);
    expect(outbox.getStatus().pending).toBe(0);
  });

  it("pendingSets returns queued set inserts for a session", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "sessions", payload: session },
      { kind: "insert", table: "sets", payload: setA },
      { kind: "insert", table: "sets", payload: setB },
    ]);

    const pending = await outbox.pendingSets(session.id);
    expect(pending).toEqual([setA, setB]);
    expect(await outbox.pendingSets("other-session")).toEqual([]);
  });
});

// Multi-user. Queued payloads leave `user_id` to the database default
// (auth.uid()), which was safe while only one person could ever be signed in.
// With two, a set queued offline by one user and flushed after the other signed
// in would be stamped with the WRONG owner — permanently, because `sets` is
// append-only and has no update path. So the item carries its owner and the
// flusher holds anything that is not the current user's.
describe("outbox identity", () => {
  const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
  const BOB = "bbbbbbbb-2222-4222-8222-222222222222";

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
  });

  it("replays only the signed-in user's queued writes", async () => {
    let who: string | null = ALICE;
    const { calls, transport } = makeTransport();
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => who,
    });

    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("aaaa1111-1111-4111-8111-111111111111", 0),
    });
    await box.flush();
    expect(calls).toHaveLength(1);

    // Alice goes offline mid-session and queues one more, then Bob signs in.
    who = ALICE;
    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("aaaa2222-1111-4111-8111-111111111111", 1),
    });
    who = BOB;
    await box.flush();
    expect(calls).toHaveLength(1); // Alice's set was NOT sent as Bob

    // It is held, not dropped: Alice signing back in replays it.
    who = ALICE;
    await box.flush();
    expect(calls).toHaveLength(2);
    expect((calls[1].payload as SetInsert).id).toBe(
      "aaaa2222-1111-4111-8111-111111111111",
    );
  });

  it("never discards the other user's work, only defers it", async () => {
    let who: string | null = ALICE;
    const { transport } = makeTransport();
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => who,
    });
    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("aaaa3333-1111-4111-8111-111111111111", 2),
    });

    who = BOB;
    await box.flush();
    const db = await getDb();
    expect((await db.getAll("outbox")).length).toBe(1);
    expect((await db.getAll("outbox"))[0].user_id).toBe(ALICE);
  });

  it("treats an item queued before multi-user as the current user's", async () => {
    // Items already in the outbox on the day this shipped carry no owner.
    // Refusing to flush them would strand real sets forever.
    const { calls, transport } = makeTransport();
    const db = await getDb();
    await db.add("outbox", {
      op: {
        kind: "insert",
        table: "sets",
        payload: makeSet("aaaa4444-1111-4111-8111-111111111111", 3),
      },
      created_at: "2026-08-25T10:00:00.000Z",
      retries: 0,
      last_error: null,
      status: "pending",
    });
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => BOB,
    });
    await box.flush();
    expect(calls).toHaveLength(1);
  });
});
