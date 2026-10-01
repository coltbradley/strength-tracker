import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutbox,
  deadKind,
  type OutboxTransport,
  type TransportError,
} from "./outbox";
import {
  cacheClearAll,
  cacheKeys,
  getDb,
  resetDbForTests,
  type Database,
  type OutboxItem,
  type OutboxOp,
} from "./db";
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
// A judgement on the ROW rather than on the caller: the same bytes come back
// refused every time, which is the one class a retry button must not offer to
// fix.
const checkErr: TransportError = {
  message: 'violates check constraint "sets_reps_check"',
  code: "23514",
  status: 400,
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
const roundOps: readonly OutboxOp[] = [
  { kind: "insert", table: "sets", payload: setA },
  { kind: "insert", table: "sets", payload: setB },
];

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

  it("stores a set round as two ordered items before any replay", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    await outbox.enqueueBatch(roundOps);

    const db = await getDb();
    expect(
      (await db.getAll("outbox")).map(
        (item) =>
          (item.op as Extract<OutboxOp, { kind: "insert"; table: "sets" }>)
            .payload.id,
      ),
    ).toEqual([setA.id, setB.id]);
  });

  it("commits a correction replacement, void, and durable link together", async () => {
    const { transport } = makeTransport();
    const box = createOutbox({ getDb, transport, isOnline: () => false, currentUserId: () => "alice", stampUserId: () => "alice" });
    const replacement = { ...setA, id: "44444444-4444-4444-8444-444444444444" };

    await box.enqueueCorrection(session.id, replacement, setA.id);

    const db = await getDb();
    const rows = await db.getAll("outbox");
    expect(rows.map((row) => [row.op.kind, row.op.table])).toEqual([
      ["insert", "sets"],
      ["insert", "set_voids"],
    ]);
    expect(rows.map((row) => row.user_id)).toEqual(["alice", "alice"]);
    expect(await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id))).toEqual({
      [replacement.id]: setA.id,
    });
  });

  it("commits an optional correction note and cached note remap with the correction", async () => {
    const { transport } = makeTransport();
    const box = createOutbox({ getDb, transport, isOnline: () => false, currentUserId: () => "alice", stampUserId: () => "alice" });
    const replacement = { ...setA, id: "abababab-abab-4bab-8bab-abababababab" };
    const db = await getDb();
    await db.put("kv", { [setA.id]: "Grip felt uneven", unrelated: "Keep me" }, cacheKeys.sessionSetNotes(session.id));

    await box.enqueueCorrection(session.id, replacement, setA.id, "Grip felt uneven");

    expect((await db.getAll("outbox")).map((row) => [row.op.kind, row.op.table, row.user_id])).toEqual([
      ["insert", "sets", "alice"],
      ["insert", "set_voids", "alice"],
      ["insert", "set_notes", "alice"],
    ]);
    expect(await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id))).toEqual({ [replacement.id]: setA.id });
    expect(await db.get("kv", cacheKeys.sessionSetNotes(session.id))).toEqual({
      unrelated: "Keep me",
      [replacement.id]: "Grip felt uneven",
    });
  });

  it("rolls back the whole correction and leaves cached note data intact when note add aborts", async () => {
    const { transport } = makeTransport();
    const db = await getDb();
    const existing: OutboxItem = {
      op: { kind: "insert", table: "sets", payload: setB },
      created_at: "2026-09-30T12:00:00.000Z",
      retries: 0,
      last_error: null,
      status: "pending",
      user_id: "alice",
    };
    await db.add("outbox", existing);
    await db.put("kv", { [setA.id]: "Grip felt uneven" }, cacheKeys.sessionSetNotes(session.id));
    await db.put("kv", { prior: "prior-set" }, cacheKeys.sessionCorrectionLinks(session.id));
    const initialRows = await db.getAll("outbox");
    const initialNotes = await db.get("kv", cacheKeys.sessionSetNotes(session.id));
    const initialLinks = await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id));
    const diskFull = new Error("disk full while adding note");
    const failingDb = {
      transaction: (...args: Parameters<Database["transaction"]>) => {
        const tx = db.transaction(...args);
        return {
          done: tx.done,
          abort: () => tx.abort(),
          objectStore(name: "outbox" | "kv") {
            const store = tx.objectStore(name);
            if (name !== "outbox") return store;
            return new Proxy(store, {
              get(target, property) {
                if (property === "add") {
                  return (value: OutboxItem, ...args2: unknown[]) => {
                    if (value.op.kind === "insert" && value.op.table === "set_notes") return Promise.reject(diskFull);
                    const method = Reflect.get(target, property) as (...methodArgs: unknown[]) => unknown;
                    return method.call(target, value, ...args2);
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        };
      },
    } as unknown as Database;
    const box = createOutbox({ getDb: () => Promise.resolve(failingDb), transport, isOnline: () => false,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    const replacement = { ...setA, id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd" };

    await expect(box.enqueueCorrection(session.id, replacement, setA.id, "Grip felt uneven"))
      .rejects.toThrow("disk full while adding note");

    expect(await db.getAll("outbox")).toEqual(initialRows);
    expect(await db.get("kv", cacheKeys.sessionSetNotes(session.id))).toEqual(initialNotes);
    expect(await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id))).toEqual(initialLinks);
  });

  it("captures enqueue owner before opening IndexedDB", async () => {
    const { calls, transport } = makeTransport();
    let owner: string | null = "alice";
    let online = false;
    let resolveDb!: (db: Database) => void;
    const pendingDb = new Promise<Database>((resolve) => { resolveDb = resolve; });
    const box = createOutbox({ getDb: () => pendingDb, transport, isOnline: () => online,
      currentUserId: () => owner, stampUserId: () => owner });

    const admission = box.enqueue({ kind: "insert", table: "sets", payload: setA });
    owner = "bob";
    resolveDb(await getDb());
    await admission;
    online = true;
    await box.flush();
    expect(await box.inspect()).toMatchObject([{ user_id: "alice", state: "held" }]);
    expect(box.getStatus()).toMatchObject({ held: 1 });
    expect(calls).toEqual([]);

    owner = "alice";
    await box.flush();
    expect(calls.map((call) => [call.table, (call.payload as SetInsert).id])).toEqual([["sets", setA.id]]);
  });

  it("captures one owner for every batch row before opening IndexedDB", async () => {
    const { calls, transport } = makeTransport();
    let owner: string | null = "alice";
    let online = false;
    let resolveDb!: (db: Database) => void;
    const pendingDb = new Promise<Database>((resolve) => { resolveDb = resolve; });
    const box = createOutbox({ getDb: () => pendingDb, transport, isOnline: () => online,
      currentUserId: () => owner, stampUserId: () => owner });

    const admission = box.enqueueBatch(roundOps);
    owner = "bob";
    resolveDb(await getDb());
    await admission;
    online = true;
    await box.flush();
    expect(await box.inspect()).toMatchObject([{ user_id: "alice" }, { user_id: "alice" }]);
    expect(box.getStatus()).toMatchObject({ held: 2 });
    expect(calls).toEqual([]);

    owner = "alice";
    await box.flush();
    expect(calls.map((call) => [call.table, (call.payload as SetInsert).id])).toEqual([
      ["sets", setA.id], ["sets", setB.id],
    ]);
  });

  it("captures correction owner before opening IndexedDB and holds it through unknown identity", async () => {
    const { calls, transport } = makeTransport();
    let liveOwner: string | null = "alice";
    let persistedOwner: string | null = "alice";
    let online = false;
    const db = await getDb();
    await db.put("kv", { [setA.id]: "Grip felt uneven" }, cacheKeys.sessionSetNotes(session.id));
    let resolveDb!: (db: Database) => void;
    const pendingDb = new Promise<Database>((resolve) => { resolveDb = resolve; });
    const box = createOutbox({ getDb: () => pendingDb, transport, isOnline: () => online,
      currentUserId: () => liveOwner, stampUserId: () => persistedOwner });
    const replacement = { ...setA, id: "efefefef-efef-4fef-8fef-efefefefefef" };

    const admission = box.enqueueCorrection(session.id, replacement, setA.id, "Grip felt uneven");
    liveOwner = null;
    resolveDb(db);
    await admission;
    online = true;
    await box.flush();
    expect(await box.inspect()).toMatchObject([
      { user_id: "alice" }, { user_id: "alice" }, { user_id: "alice" },
    ]);
    expect(box.getStatus()).toMatchObject({ held: 3 });
    expect(calls).toEqual([]);
    expect(await db.get("kv", cacheKeys.sessionSetNotes(session.id))).toEqual({ [replacement.id]: "Grip felt uneven" });

    liveOwner = "bob";
    await box.flush();
    expect(calls).toEqual([]);
    expect(box.getStatus()).toMatchObject({ held: 3 });
    liveOwner = "alice";
    await box.flush();
    expect(calls.map((call) => [call.table, (call.payload as { id?: string; set_id?: string }).id ?? (call.payload as { set_id?: string }).set_id]))
      .toEqual([["sets", replacement.id], ["set_voids", setA.id], ["set_notes", replacement.id]]);
    db.close();
    const reopened = await openDB(db.name, 1) as Database;
    expect(await reopened.get("kv", cacheKeys.sessionSetNotes(session.id))).toEqual({
      [replacement.id]: "Grip felt uneven",
    });
  });

  it("does not place an unknown-owner correction note in the account cache", async () => {
    const { transport } = makeTransport();
    const db = await getDb();
    await db.put("kv", { existing: "current account note" }, cacheKeys.sessionSetNotes(session.id));
    const box = createOutbox({ getDb, transport, isOnline: () => false,
      currentUserId: () => null, stampUserId: () => null });
    const replacement = { ...setA, id: "12121212-1212-4212-8212-121212121212" };

    await box.enqueueCorrection(session.id, replacement, setA.id, "queued under unknown owner");

    expect((await db.getAll("outbox")).map((row) => row.user_id)).toEqual([null, null, null]);
    expect(await db.get("kv", cacheKeys.sessionSetNotes(session.id))).toEqual({ existing: "current account note" });
  });

  it("rolls back replacement and void when the durable link cannot commit", async () => {
    const { transport } = makeTransport();
    const db = await getDb();
    const diskFull = new Error("disk full");
    const failingDb = {
      transaction: (...args: Parameters<Database["transaction"]>) => {
        const tx = db.transaction(...args);
        return {
          done: tx.done,
          abort: () => tx.abort(),
          objectStore(name: "outbox" | "kv") {
            const store = tx.objectStore(name);
            if (name !== "kv") return store;
            return new Proxy(store, {
              get(target, property) {
                if (property === "put") {
                  return (...putArgs: unknown[]) => {
                    const putMethod = Reflect.get(target, "put") as (...args: unknown[]) => unknown;
                    const rawPut = putMethod.bind(target);
                    void Promise.resolve(rawPut(...putArgs)).catch(() => undefined);
                    return Promise.reject(diskFull);
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        };
      },
    } as unknown as Database;
    const box = createOutbox({ getDb: () => Promise.resolve(failingDb), transport, isOnline: () => false });
    const replacement = { ...setA, id: "44444444-4444-4444-8444-444444444444" };

    await expect(box.enqueueCorrection(session.id, replacement, setA.id)).rejects.toThrow("disk full");

    expect(await db.getAll("outbox")).toEqual([]);
    expect(await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id))).toBeUndefined();
  });

  it("retains an owner-bound correction join on the pending void after cache clear", async () => {
    const { transport } = makeTransport();
    const box = createOutbox({ getDb, transport, isOnline: () => false, currentUserId: () => "alice", stampUserId: () => "alice" });
    const replacement = { ...setA, id: "55555555-5555-4555-8555-555555555555" };
    await box.enqueueCorrection(session.id, replacement, setA.id);
    const db = await getDb();
    await db.delete("outbox", 1); // replacement insert was accepted by the server

    await cacheClearAll();

    expect(await db.get("kv", cacheKeys.sessionCorrectionLinks(session.id))).toBeUndefined();
    expect(await box.inspect()).toMatchObject([{
      table: "set_voids",
      user_id: "alice",
      correction_link: {
        session_id: session.id,
        replacement_id: replacement.id,
        original_id: setA.id,
      },
      state: "waiting",
    }]);
  });

  it("keeps the original visible when a dead replacement is followed by an independent set", async () => {
    const replacement = { ...setA, id: "77777777-7777-4777-8777-777777777777" };
    const calls: Call[] = [];
    let online = false;
    const transport: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ kind: "insert", table, payload });
        if (table === "sets" && (payload as SetInsert).id === replacement.id) return checkErr;
        return null;
      },
      async update() { return null; },
    };
    const box = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    await box.enqueueCorrection(session.id, replacement, setA.id);
    await box.enqueue({ kind: "insert", table: "sets", payload: setB });

    online = true;
    await box.flush();

    expect(calls.map((call) => [call.table, (call.payload as { id?: string; set_id?: string }).id ?? (call.payload as { set_id?: string }).set_id]))
      .toEqual([["sets", replacement.id], ["sets", setB.id]]);
    expect(await box.inspect()).toMatchObject([
      { table: "sets", state: "dead" },
      { table: "set_voids", state: "waiting", correction_link: { original_id: setA.id } },
    ]);

    // A fresh outbox instance simulates reload. The correction void remains
    // queued and cannot hide the already accepted original set.
    const reloaded = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    await reloaded.flush();
    expect(calls).toHaveLength(2);
    expect((await reloaded.inspect()).map((row) => [row.table, row.state]))
      .toEqual([["sets", "dead"], ["set_voids", "waiting"]]);
  });

  it("sends a linked void after retrying and acknowledging its replacement", async () => {
    const replacement = { ...setA, id: "88888888-8888-4888-8888-888888888888" };
    const calls: Call[] = [];
    const responses: Array<TransportError | null> = [rlsErr];
    let online = false;
    const transport: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ kind: "insert", table, payload });
        const response = responses.shift();
        return response === undefined ? null : response;
      },
      async update() { return null; },
    };
    const box = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    await box.enqueueCorrection(session.id, replacement, setA.id);
    online = true;
    await box.flush();
    expect(calls.map((call) => call.table)).toEqual(["sets"]);
    expect(await box.inspect()).toMatchObject([
      { table: "sets", state: "dead" },
      { table: "set_voids", state: "waiting" },
    ]);

    await box.retryDead();

    expect(calls.map((call) => call.table)).toEqual(["sets", "sets", "set_voids"]);
    expect(await box.inspect()).toEqual([]);
  });

  it("keeps a dead linked void parked when its replacement cannot be retried", async () => {
    const replacement = { ...setA, id: "99999999-9999-4999-8999-999999999999" };
    const { calls, transport } = makeTransport();
    let online = false;
    const box = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    await box.enqueueCorrection(session.id, replacement, setA.id);
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      const replacementRow = item.op.kind === "insert" && item.op.table === "sets";
      await db.put("outbox", {
        ...item,
        status: "dead",
        last_error: replacementRow ? checkErr.message : rlsErr.message,
        last_code: replacementRow ? checkErr.code : rlsErr.code,
        last_status: replacementRow ? checkErr.status : rlsErr.status,
      }, key);
    }

    online = true;
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 2 });
    expect(calls).toEqual([]);
    expect((await box.inspect()).map((row) => [row.table, row.state]))
      .toEqual([["sets", "dead"], ["set_voids", "dead"]]);
  });

  it("retries a dead linked void only alongside its retryable replacement", async () => {
    const replacement = { ...setA, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const { calls, transport } = makeTransport();
    let online = false;
    const box = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => "alice", stampUserId: () => "alice" });
    await box.enqueueCorrection(session.id, replacement, setA.id);
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      await db.put("outbox", {
        ...item,
        status: "dead",
        last_error: "permission denied",
        last_code: "42501",
        last_status: 403,
      }, key);
    }

    online = true;
    expect(await box.retryDead()).toEqual({ requeued: 2, stuck: 0 });
    expect(calls.map((call) => call.table)).toEqual(["sets", "set_voids"]);
    expect(await box.inspect()).toEqual([]);
  });

  it("is not 'known' until a count has actually been read (M4)", async () => {
    const { transport } = makeTransport();
    const box = createOutbox({ getDb, transport, isOnline: () => false });
    // the all-zero idle snapshot looks exactly like an empty queue
    expect(box.getStatus()).toMatchObject({ pending: 0, dead: 0, held: 0, state: "idle" });
    expect(box.isStatusKnown()).toBe(false);

    await box.enqueue({ kind: "insert", table: "sets", payload: setA });
    expect(box.isStatusKnown()).toBe(true);
    expect(box.getStatus().pending).toBe(1);
  });

  it("keeps an owner-bound ACK witness after both writes leave the queue", async () => {
    const { transport, calls } = makeTransport();
    let online = false;
    let owner: string | null = "alice";
    const box = createOutbox({ getDb, transport, isOnline: () => online,
      currentUserId: () => owner, stampUserId: () => owner });
    const replacement = { ...setA, id: "66666666-6666-4666-8666-666666666666" };
    await box.enqueueCorrection(session.id, replacement, setA.id);
    online = true;
    await box.flush();

    expect(await box.inspect()).toEqual([]);
    expect(box.getStatus()).toMatchObject({ pending: 0, dead: 0, held: 0 });
    expect(await box.pendingVoidIds()).toEqual(new Set());
    expect(await box.correctionLinks(session.id)).toEqual({ [replacement.id]: setA.id });
    await cacheClearAll();
    expect(await box.correctionLinks(session.id)).toEqual({ [replacement.id]: setA.id });
    await box.flush();
    expect(calls).toHaveLength(2);

    owner = "bob";
    expect(await box.correctionLinks(session.id)).toEqual({});
    owner = null;
    expect(await box.correctionLinks(session.id)).toEqual({});
    const witnesses = (await (await getDb()).getAll("outbox"))
      .filter((item) => item.status === "receipt");
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]?.user_id).toBe("alice");
    expect(witnesses[0]?.correction_link).toMatchObject({
      replacement_id: replacement.id,
      original_id: setA.id,
    });
  });

  it("resolves a single enqueue after commit when the count refresh fails", async () => {
    const { transport } = makeTransport();
    const db = await getDb();
    const refreshFailure = new Error("count refresh failed");
    const failingRefreshDb = {
      add: (...args: Parameters<Database["add"]>) => db.add(...args),
      transaction: (store: "outbox", mode?: "readonly" | "readwrite") => {
        if (mode === undefined) throw refreshFailure;
        return db.transaction(store, mode);
      },
    } as unknown as Database;
    const outbox = createOutbox({
      getDb: () => Promise.resolve(failingRefreshDb),
      transport,
      isOnline: () => false,
    });

    await expect(
      outbox.enqueue({ kind: "insert", table: "sets", payload: setA }),
    ).resolves.toBeUndefined();

    expect((await db.getAll("outbox")).map((item) => item.op)).toEqual([
      { kind: "insert", table: "sets", payload: setA },
    ]);
    expect(outbox.getStatus()).toMatchObject({
      state: "error",
      lastError: expect.stringContaining("count refresh failed"),
    });
  });

  it("resolves a batch enqueue after commit when the count refresh fails", async () => {
    const { transport } = makeTransport();
    const db = await getDb();
    const refreshFailure = new Error("count refresh failed");
    const failingRefreshDb = {
      add: (...args: Parameters<Database["add"]>) => db.add(...args),
      transaction: (store: "outbox", mode?: "readonly" | "readwrite") => {
        if (mode === undefined) throw refreshFailure;
        return db.transaction(store, mode);
      },
    } as unknown as Database;
    const outbox = createOutbox({
      getDb: () => Promise.resolve(failingRefreshDb),
      transport,
      isOnline: () => false,
    });

    await expect(outbox.enqueueBatch(roundOps)).resolves.toBeUndefined();

    expect(
      (await db.getAll("outbox")).map((item) =>
        (item.op as Extract<OutboxOp, { kind: "insert"; table: "sets" }>)
          .payload.id,
      ),
    ).toEqual([setA.id, setB.id]);
  });

  it("leaves no part of the batch when its IndexedDB transaction aborts", async () => {
    const { transport } = makeTransport();
    const rows: OutboxItem[] = [];
    let firstItemReachedCommittedView = false;
    const diskFull = new Error("disk full");
    const failingDb = {
      // A non-transactional implementation would call this twice: the first
      // write persists and the second failure leaves it behind.
      add: async (_store: "outbox", item: OutboxItem) => {
        if (rows.length === 1) throw diskFull;
        rows.push(item);
        return rows.length;
      },
      count: async (_store: "outbox") => rows.length,
      transaction: () => {
        // IndexedDB writes are visible in the transaction's store, then an
        // abort restores the committed store to its pre-transaction state.
        const before = [...rows];
        let writes = 0;
        let rejectDone: (reason?: unknown) => void = () => undefined;
        const done = new Promise<void>((_resolve, reject) => {
          rejectDone = reject;
        });
        void done.catch(() => {
          rows.splice(0, rows.length, ...before);
        });
        return {
          store: {
            add: async (item: OutboxItem) => {
              if (writes === 1) {
                firstItemReachedCommittedView = rows.length === 1;
                rejectDone(diskFull);
                throw diskFull;
              }
              rows.push(item);
              writes++;
              return rows.length;
            },
          },
          done,
        };
      },
    } as unknown as Database;
    const failingOutbox = createOutbox({
      getDb: () => Promise.resolve(failingDb),
      transport,
      isOnline: () => false,
    });

    await expect(failingOutbox.enqueueBatch(roundOps)).rejects.toThrow(
      "disk full",
    );

    await Promise.resolve(); // wait for the transaction abort to restore rows
    expect(firstItemReachedCommittedView).toBe(true);
    expect(await failingDb.count("outbox")).toBe(0);
  });

  it("replays both batch members in order and preserves normal idempotency", async () => {
    const { calls, transport } = makeTransport();
    const outbox = build(transport);

    await outbox.enqueueBatch(roundOps);
    online = true;
    await outbox.flush();

    expect(calls.map((call) => (call.payload as SetInsert).id)).toEqual([
      setA.id,
      setB.id,
    ]);
  });

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
      held: 0,
      state: "idle",
      lastError: null,
    });
  });

  it("keeps a session close that matched no row visible and retryable (A-91)", async () => {
    // The update transport asks for the row back with .single(); PostgREST
    // answers a zero-row match with 406 / PGRST116. Treating that as success
    // deleted the close from the queue while the server session stayed open.
    const zeroRows: TransportError = {
      message: "JSON object requested, multiple (or no) rows returned",
      code: "PGRST116",
      status: 406,
    };
    const { calls, transport } = makeTransport([zeroRows]);
    const outbox = build(transport);

    await seed(outbox, [
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
      { kind: "insert", table: "sets", payload: setA },
    ]);

    online = true;
    await outbox.flush();

    // It must not block the queue behind it...
    expect(calls.map((c) => `${c.kind}:${c.table}`)).toEqual([
      "update:sessions",
      "insert:sets",
    ]);
    // ...and it must stay, dead but offered for retry.
    const items = await outbox.inspect();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      table: "sessions",
      state: "dead",
      retryable: true,
    });
    expect(deadKind("PGRST116", 406)).toBe("blocked");
  });

  it("retries a transient failure on its own while the app stays open and online (A-143)", async () => {
    // Only the timers: fake-indexeddb schedules its own work with setImmediate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { calls, transport } = makeTransport([netErr(), netErr()]);
      const outbox = createOutbox({
        getDb,
        transport,
        isOnline: () => true,
        retryDelaysMs: [1_000, 5_000],
      });
      // Let IndexedDB (setImmediate, not faked) settle the flush enqueue fires.
      const drain = async () => {
        for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      };
      await outbox.enqueue({ kind: "insert", table: "sets", payload: setA });
      await drain();
      expect(calls).toHaveLength(1); // the enqueue's own flush, failed

      await vi.advanceTimersByTimeAsync(1_000);
      await drain();
      expect(calls).toHaveLength(2); // first backoff, failed again

      await vi.advanceTimersByTimeAsync(4_999);
      await drain();
      expect(calls).toHaveLength(2); // the second delay is longer
      await vi.advanceTimersByTimeAsync(1);
      await drain();
      expect(calls).toHaveLength(3); // and succeeds
      expect(outbox.getStatus().pending).toBe(0);

      // Nothing left to retry, so nothing else is scheduled.
      await vi.advanceTimersByTimeAsync(60_000);
      await drain();
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
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
      held: 0,
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
      held: 0,
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
      held: 0,
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
      held: 0,
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

  it("401 with an UNREACHABLE refresh keeps the item pending, not dead", async () => {
    // A refresh that threw and a refresh that returned false are different
    // answers. Throwing means we never found out — getSession() timed out on
    // gym wifi. Treating that as a verdict dead-lettered the whole queue for a
    // transient condition, and since the refresh is attempted once per flush,
    // every following item skipped it and died too.
    const { calls, transport } = makeTransport([authErr, authErr]);
    const refreshAuth = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const outbox = build({ ...transport, refreshAuth });

    await seed(outbox, [
      { kind: "insert", table: "sets", payload: setA },
      { kind: "insert", table: "sets", payload: setB },
    ]);

    online = true;
    await outbox.flush();

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // stopped, rather than marching on
    expect(outbox.getStatus().dead).toBe(0);
    expect(outbox.getStatus().pending).toBe(2);
    expect(outbox.getStatus().state).toBe("error");
  });

  it("and sends them once the refresh can actually answer", async () => {
    const { calls, transport } = makeTransport([authErr]);
    const refreshAuth = vi.fn(async () => true);
    const outbox = build({ ...transport, refreshAuth });

    await seed(outbox, [{ kind: "insert", table: "sets", payload: setA }]);
    online = true;
    await outbox.flush();

    expect(outbox.getStatus().pending).toBe(0);
    expect(outbox.getStatus().dead).toBe(0);
    expect(calls).toHaveLength(2);
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

  it("pendingVoidIds returns the set ids of queued voids", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "sets", payload: setA },
      { kind: "insert", table: "set_voids", payload: { set_id: setA.id } },
      // a set_notes insert shares the set_id shape and must not be counted:
      // annotating a set is not removing it
      {
        kind: "insert",
        table: "set_notes",
        payload: { set_id: setB.id, note: "felt heavy" },
      },
    ]);

    expect(await outbox.pendingVoidIds()).toEqual(new Set([setA.id]));
  });

  it("pendingVoidIds keeps dead-lettered voids — the user still asked", async () => {
    // consistent with pendingSets and pendingSessionUpdateIds, neither of
    // which filters on status: a void that failed to replay has still been
    // asked for, and putting the set back on screen is the one answer the
    // user already rejected.
    const { transport } = makeTransport([rlsErr]);
    const outbox = build(transport);

    await seed(outbox, [
      { kind: "insert", table: "set_voids", payload: { set_id: setA.id } },
    ]);
    online = true;
    await outbox.flush();
    expect(outbox.getStatus().dead).toBe(1);

    expect(await outbox.pendingVoidIds()).toEqual(new Set([setA.id]));
  });

  it("pendingVoidIds is empty when nothing is queued", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    expect(await outbox.pendingVoidIds()).toEqual(new Set());

    // and empty again once a queued void has actually landed
    await seed(outbox, [
      { kind: "insert", table: "set_voids", payload: { set_id: setA.id } },
    ]);
    online = true;
    await outbox.flush();
    expect(await outbox.pendingVoidIds()).toEqual(new Set());
  });

  it("pendingDiscardIds counts discards but not ends", async () => {
    const { transport } = makeTransport();
    const outbox = build(transport);

    await seed(outbox, [
      {
        kind: "update",
        table: "sessions",
        id: session.id,
        patch: {
          ended_at: "2026-08-25T11:00:00.000Z",
          session_rpe: null,
          bodyweight_kg: null,
          notes: null,
        },
      },
      {
        kind: "update",
        table: "sessions",
        id: "99999999-9999-4999-8999-999999999999",
        patch: { discarded_at: "2026-08-25T11:05:00.000Z" },
      },
    ]);

    // both are queued sessions updates...
    expect(await outbox.pendingSessionUpdateIds()).toEqual(
      new Set([session.id, "99999999-9999-4999-8999-999999999999"]),
    );
    // ...but only one of them says the day should disappear. A session
    // finished offline must keep showing in history.
    expect(await outbox.pendingDiscardIds()).toEqual(
      new Set(["99999999-9999-4999-8999-999999999999"]),
    );
  });

  it("does not hide a session after the server rejects its discard", async () => {
    const discardErr: TransportError = {
      message: "cannot discard a session that contains sets",
      code: "23514",
      status: 400,
    };
    const { transport } = makeTransport([discardErr]);
    const outbox = build(transport);
    const id = "99999999-9999-4999-8999-999999999999";

    await seed(outbox, [
      {
        kind: "update",
        table: "sessions",
        id,
        patch: { discarded_at: "2026-08-25T11:05:00.000Z" },
      },
    ]);
    online = true;
    await outbox.flush();

    expect(outbox.getStatus().dead).toBe(1);
    expect(await outbox.pendingDiscardIds()).toEqual(new Set());
    const entry = (await outbox.inspect())[0];
    expect(entry).toMatchObject({
      state: "dead",
      cause: "rejected",
      retryable: false,
    });
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

  it("holds a write queued while NO identity was known, even after one arrives (A-90)", async () => {
    // Enqueued in the boot window before identity resolved. Nothing says
    // whose set this is, so it must not replay as whoever signs in next.
    let who: string | null = null;
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
      payload: makeSet("aaaa3333-1111-4111-8111-111111111111", 0),
    });
    who = BOB;
    await box.flush();

    expect(calls).toHaveLength(0);
    const [entry] = await box.inspect();
    expect(entry).toMatchObject({ state: "held", user_id: null });
  });

  it("stamps the device's persisted owner when live identity is not known yet (A-90)", async () => {
    let who: string | null = null;
    const { calls, transport } = makeTransport();
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => who,
      stampUserId: () => who ?? ALICE,
    });

    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("aaaa4444-1111-4111-8111-111111111111", 0),
    });
    who = BOB;
    await box.flush();
    expect(calls).toHaveLength(0); // Alice's set is not sent as Bob

    who = ALICE;
    await box.flush();
    expect(calls).toHaveLength(1);
  });

  it("still replays a legacy item that predates owner stamping", async () => {
    const { calls, transport } = makeTransport();
    const db = await getDb();
    await db.add("outbox", {
      op: {
        kind: "insert",
        table: "sets",
        payload: makeSet("aaaa5555-1111-4111-8111-111111111111", 0),
      },
      created_at: "2026-08-01T10:00:00.000Z",
      retries: 0,
      last_error: null,
      status: "pending",
    });
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => ALICE,
    });
    await box.flush();
    expect(calls).toHaveLength(1);
  });

  it("holds a stamped item while identity is still unknown", async () => {
    // The boot race. getCurrentUserId() returns null for "signed out" AND for
    // "not known yet", and start() flushes after two IndexedDB round-trips
    // while identity resolution is a network token refresh — IndexedDB wins
    // that race on any morning the stored token has expired. Treating null as
    // permission sent the item with no user_id, and the column's
    // `default auth.uid()` stamped it with whoever was actually signed in.
    // In an append-only table, that misattribution is permanent.
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
      payload: makeSet("aaaa4444-1111-4111-8111-111111111111", 3),
    });

    who = null; // identity not resolved yet
    await box.flush();
    expect(calls).toHaveLength(0);

    // Held, never dropped — it goes the moment we know who we are.
    who = ALICE;
    await box.flush();
    expect(calls).toHaveLength(1);
    expect((calls[0].payload as SetInsert).id).toBe(
      "aaaa4444-1111-4111-8111-111111111111",
    );
  });

  it("re-runs the queue when identity arrives, without another trigger", async () => {
    // Holding is only safe if something un-holds it. Nothing else would:
    // start() flushes once, and the next trigger is an `online` event or the
    // next write — neither of which happens for someone who opens the app
    // just to look at yesterday.
    let who: string | null = null;
    let announce: ((id: string | null) => void) | null = null;
    const { calls, transport } = makeTransport();
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => who,
      onIdentityChange: (fn) => {
        announce = fn;
        return () => {};
      },
    });

    const db = await getDb();
    await db.add("outbox", {
      op: {
        kind: "insert",
        table: "sets",
        payload: makeSet("aaaa5555-1111-4111-8111-111111111111", 4),
      },
      user_id: ALICE,
      status: "pending",
    } as never);

    // start() also wires an `online` listener; this file runs in node, which
    // has no window. The subscription under test is the identity one.
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => {},
    };
    try {
      box.start();
    } finally {
      if (priorWindow === undefined)
        delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = priorWindow;
    }
    await box.flush();
    expect(calls).toHaveLength(0); // identity still unknown

    who = ALICE;
    announce!(ALICE);
    await box.flush();
    expect(calls).toHaveLength(1);
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

// The queue was invisible. Nothing on screen said a set had not reached the
// server, and the only action offered ("retry failed") re-queued every dead
// item blindly — including the ones the server refuses on the merits of the
// row, which came straight back as failures. These are the reads and the
// narrowed retry that <OutboxSheet> is built on.
describe("outbox visibility", () => {
  const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
  const BOB = "bbbbbbbb-2222-4222-8222-222222222222";
  const setC = makeSet("cccccccc-3333-4333-8333-333333333333", 2);
  const setD = makeSet("dddddddd-4444-4444-8444-444444444444", 3);

  it("repairs seven exported sets atomically while preserving keys and training data", async () => {
    let who = ALICE;
    const calls: Call[] = [];
    const box = createOutbox({ admit: () => undefined, getDb, currentUserId: () => who, isOnline: () => false,
      transport: { async insert(table, payload) { calls.push({ kind: "insert", table, payload }); return null; }, async update() { return null; } } });
    const originals = Array.from({ length: 7 }, (_, i): SetInsert => ({
      ...makeSet(`0000000${i}-1111-4111-8111-111111111111`, i),
      load_kg: [65.77, 34.02, 45.36, 52.16, 65.77, 34.02, 45.36][i],
      load_entry: "total", entered_load: [65.8, 34, 45.4, 52.2, 65.8, 34, 45.4][i],
      entered_unit: "kg", rpe: 8,
    }));
    await box.enqueueBatch(originals.map((payload) => ({ kind: "insert" as const, table: "sets" as const, payload })));
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      await db.put("outbox", { ...item, status: "dead", retries: 1,
        last_error: "load_kg must match entered_load, entered_unit, and load_entry",
        last_code: "23514", last_status: 400 }, key);
    }
    const exported = await box.inspect();
    expect(exported).toHaveLength(7);
    expect(await box.repairDeadLoadSets(exported)).toBe(true);
    const repaired = await box.inspect();
    expect(repaired.map((e) => e.key)).toEqual(exported.map((e) => e.key));
    expect(repaired.map((e) => e.user_id)).toEqual(Array(7).fill(ALICE));
    expect(repaired.map((e) => e.state)).toEqual(Array(7).fill("waiting"));
    expect(repaired.map((e) => e.op)).toEqual(originals.map((payload) => ({ kind: "insert", table: "sets",
      payload: { ...payload, entered_load: null, entered_unit: null } })));
    expect(exported.map((e) => (e.op as Extract<OutboxOp, { kind: "insert"; table: "sets" }>).payload.entered_load))
      .toEqual(originals.map((set) => set.entered_load));
    expect(calls).toHaveLength(0);
    who = BOB;
    await box.flush();
    expect(calls).toHaveLength(0);
  });

  it("changes none when one exported row is stale or the owner changes", async () => {
    let who = ALICE;
    const { transport } = makeTransport();
    const box = createOutbox({ admit: () => undefined, getDb, transport, currentUserId: () => who, isOnline: () => false });
    const authored = [setA, setB].map((set) => ({ ...set, load_entry: "total" as const,
      entered_load: 220.5, entered_unit: "lb" as const }));
    await box.enqueueBatch(authored.map((payload) => ({ kind: "insert" as const, table: "sets" as const, payload })));
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      await db.put("outbox", { ...item, status: "dead", last_code: "23514", last_status: 400,
        last_error: "load_kg must match entered_load, entered_unit, and load_entry" }, key);
    }
    const exported = await box.inspect();
    const second = (await db.get("outbox", exported[1].key))!;
    await db.put("outbox", { ...second, retries: 2 }, exported[1].key);
    expect(await box.repairDeadLoadSets(exported)).toBe(false);
    expect((await db.get("outbox", exported[0].key))?.status).toBe("dead");
    await db.put("outbox", second, exported[1].key);
    who = BOB;
    expect(await box.repairDeadLoadSets(exported)).toBe(false);
    expect((await db.get("outbox", exported[0].key))?.status).toBe("dead");
    who = ALICE;
    expect(await box.repairDeadLoadSets(exported.slice(0, 1))).toBe(false);
    expect((await db.get("outbox", exported[1].key))?.status).toBe("dead");
    await db.put("outbox", { ...second, user_id: BOB }, exported[1].key);
    const mixedOwners = await box.inspect();
    expect(await box.repairDeadLoadSets(mixedOwners)).toBe(false);
    expect((await db.get("outbox", exported[0].key))?.status).toBe("dead");
  });

  it("holds dependent writes until parents land and keeps a partial replay failure visible", async () => {
    let online = false;
    const calls: Call[] = [];
    const transport: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ kind: "insert", table, payload });
        return table === "sets" && (payload as SetInsert).id === setA.id ? checkErr : null;
      },
      async update() { return null; },
    };
    const box = createOutbox({ admit: () => undefined, getDb, transport, currentUserId: () => ALICE, isOnline: () => online });
    const authored = [setA, setB].map((set) => ({ ...set, load_entry: "total" as const,
      entered_load: 220.5, entered_unit: "lb" as const }));
    await box.enqueueBatch([
      ...authored.map((payload) => ({ kind: "insert" as const, table: "sets" as const, payload })),
      { kind: "insert", table: "set_voids", payload: { set_id: setA.id } },
    ]);
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      await db.put("outbox", { ...item, status: "dead", last_code: item.op.table === "sets" ? "23514" : "42501",
        last_status: item.op.table === "sets" ? 400 : 403,
        last_error: item.op.table === "sets"
          ? "load_kg must match entered_load, entered_unit, and load_entry" : "RLS refused" }, key);
    }
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 3 });
    const exported = (await box.inspect()).filter((entry) => entry.loadRepairable);
    expect(await box.repairDeadLoadSets(exported)).toBe(true);
    online = true;
    await box.flush();
    const remaining = await box.inspect();
    expect(remaining.map((row) => [row.table, row.state])).toEqual([
      ["sets", "dead"], ["set_voids", "dead"],
    ]);
    expect(calls.map((call) => call.table)).toEqual(["sets", "sets"]);
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 2 });
    expect((await box.inspect()).map((row) => row.table)).toEqual(["sets", "set_voids"]);
  });

  it("repairs only the exact authored-load failure without changing the logged set", async () => {
    let online = false;
    const { calls, transport } = makeTransport([{
      code: "23514",
      status: 400,
      message: "load_kg must match entered_load, entered_unit, and load_entry",
    }]);
    const original: SetInsert = {
      ...setA,
      load_kg: 100,
      load_entry: "total",
      entered_load: 220.5,
      entered_unit: "lb",
      reps: 6,
      rpe: 8,
    };
    const box = createOutbox({
      admit: () => undefined, // models dead items queued by a build before the gate
      getDb,
      transport,
      isOnline: () => online,
      currentUserId: () => ALICE,
    });
    await box.enqueue({ kind: "insert", table: "sets", payload: original });
    online = true;
    await box.flush();
    const [failed] = await box.inspect();
    expect(failed.state).toBe("dead");

    expect(await box.repairDeadLoadSet(failed.key, original)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].payload).toEqual({
      ...original,
      entered_load: null,
      entered_unit: null,
    });
    expect(box.getStatus().dead).toBe(0);
    expect((await box.inspect())).toHaveLength(0);
  });

  it("never repairs a different constraint or another owner's failed set", async () => {
    let online = false;
    let who = ALICE;
    const { calls, transport } = makeTransport([
      { code: "23514", status: 400, message: "load_kg must match entered_load, entered_unit, and load_entry" },
      checkErr,
    ]);
    const authored = { ...setB, load_entry: "total" as const, entered_load: 220.5, entered_unit: "lb" as const };
    const box = createOutbox({ admit: () => undefined, getDb, transport, isOnline: () => online, currentUserId: () => who });
    await box.enqueue({ kind: "insert", table: "sets", payload: setA });
    who = BOB;
    await box.enqueue({ kind: "insert", table: "sets", payload: authored });
    online = true;
    await box.flush();
    who = ALICE;
    await box.flush();
    const rows = await box.inspect();
    expect(await box.repairDeadLoadSet(rows[0].key, setA)).toBe(false);
    expect(await box.repairDeadLoadSet(rows[1].key, authored)).toBe(false);
    expect(calls).toHaveLength(2);
    expect((await box.inspect()).map((r) => r.state)).toEqual(["dead", "dead"]);
  });

  it("repairs a failed set before retrying its refused void and note in queue order", async () => {
    let online = false;
    let who: string | null = ALICE;
    const calls: Array<{ table: string; payload: unknown; owner: string | null }> = [];
    const landedSets = new Set<string>();
    const original: SetInsert = {
      ...setA,
      load_entry: "total",
      entered_load: 220.5,
      entered_unit: "lb",
    };
    const voidRow = { set_id: original.id };
    const noteRow = { set_id: original.id, note: "Left shoulder felt tight" };
    const transport: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ table, payload, owner: who });
        if (table === "sets") {
          const set = payload as SetInsert;
          if (set.entered_load != null) {
            return {
              code: "23514",
              status: 400,
              message: "load_kg must match entered_load, entered_unit, and load_entry",
            };
          }
          landedSets.add(set.id);
          return null;
        }
        if ((table === "set_voids" || table === "set_notes") &&
            !landedSets.has((payload as { set_id: string }).set_id)) {
          return { code: "42501", status: 403, message: "new row violates row-level security policy" };
        }
        return null;
      },
      async update() { return null; },
    };
    const box = createOutbox({
      admit: () => undefined, // models dead items queued by a build before the gate
      getDb,
      transport,
      isOnline: () => online,
      currentUserId: () => who,
    });
    await box.enqueueBatch([
      { kind: "insert", table: "sets", payload: original },
      { kind: "insert", table: "set_voids", payload: voidRow },
      { kind: "insert", table: "set_notes", payload: noteRow },
    ]);
    online = true;
    await box.flush();
    const failed = await box.inspect();
    expect(failed.map((e) => [e.table, e.state, e.cause, e.user_id])).toEqual([
      ["sets", "dead", "rejected", ALICE],
      ["set_voids", "dead", "blocked", ALICE],
      ["set_notes", "dead", "blocked", ALICE],
    ]);
    expect(await box.pendingVoidIds()).toEqual(new Set([original.id]));

    expect(await box.repairDeadLoadSet(failed[0].key, original)).toBe(true);
    expect(landedSets.has(original.id)).toBe(true);
    expect((await box.inspect()).map((e) => e.table)).toEqual(["set_voids", "set_notes"]);
    who = BOB;
    expect(await box.retryDead()).toEqual({ requeued: 2, stuck: 0 });
    expect(box.getStatus()).toMatchObject({ pending: 2, held: 2, dead: 0 });
    expect(calls).toHaveLength(4); // neither child was sent as Bob
    who = ALICE;
    await box.flush();

    expect(calls.map((c) => c.table)).toEqual([
      "sets", "set_voids", "set_notes", "sets", "set_voids", "set_notes",
    ]);
    expect(calls.every((c) => c.owner === ALICE)).toBe(true);
    expect(calls[3].payload).toEqual({ ...original, entered_load: null, entered_unit: null });
    expect(calls[4].payload).toEqual(voidRow);
    expect(calls[5].payload).toEqual(noteRow);
    expect(await box.inspect()).toEqual([]);
    expect(await box.pendingVoidIds()).toEqual(new Set());
  });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
  });

  it("reads the cause off the code and status, never off the message", () => {
    // A 401 whose refresh answered "no": a later sign-in changes it.
    expect(deadKind(null, 401)).toBe("auth");
    // Refused by state OUTSIDE the payload — a policy judging the caller, or
    // an ancestor row that has not landed yet. Both can change on a replay.
    expect(deadKind("42501", 403)).toBe("blocked");
    expect(deadKind("23503", 409)).toBe("blocked");
    // ...and the code wins over the status, so a 409 carrying an FK is still
    // blocked while a bare 409 is a conflict on the row.
    expect(deadKind(null, 409)).toBe("rejected");
    // A judgement on the row: not-null, check, unique.
    expect(deadKind("23502", 400)).toBe("rejected");
    expect(deadKind("23514", 400)).toBe("rejected");
    expect(deadKind("23505", 409)).toBe("rejected");
    // No evidence at all — an item that died before the code was recorded,
    // and a 404, which is about the endpoint rather than the row.
    expect(deadKind(null, null)).toBe("unknown");
    expect(deadKind(undefined, undefined)).toBe("unknown");
    expect(deadKind(null, 404)).toBe("unknown");
  });

  it("counts waiting, held and dead apart, and names each one", async () => {
    let online = false;
    let who: string | null = ALICE;
    const { transport } = makeTransport([checkErr]);
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => online,
      currentUserId: () => who,
    });

    await box.enqueue({ kind: "insert", table: "sets", payload: setA });
    who = BOB; // someone else borrows the phone
    await box.enqueue({ kind: "insert", table: "sets", payload: setB });
    who = ALICE;
    await box.enqueue({ kind: "insert", table: "sets", payload: setC });

    online = true;
    await box.flush();
    // setA was refused on its own merits; setB is not this device's to send;
    // setC went up and left the queue.
    online = false;
    await box.enqueue({ kind: "insert", table: "sets", payload: setD });

    // `held` is a SUBSET of `pending`: the item is queued and healthy, this
    // device is simply not the one to send it. Every existing reader of
    // `pending` still counts the same things it did.
    expect(box.getStatus()).toMatchObject({ pending: 2, held: 1, dead: 1 });

    const entries = await box.inspect();
    expect(entries.map((e) => e.state)).toEqual(["dead", "held", "waiting"]);
    expect(entries[0]).toMatchObject({
      cause: "rejected",
      retryable: false,
      last_error: checkErr.message,
      user_id: ALICE,
    });
    expect(entries[1]).toMatchObject({
      cause: null,
      retryable: false,
      user_id: BOB,
    });
    expect(entries[2]).toMatchObject({ cause: null, user_id: ALICE });
    // Replay order is the queue order, and the view shows it that way.
    expect(entries.map((e) => e.key)).toEqual(
      [...entries.map((e) => e.key)].sort((a, b) => a - b),
    );
  });

  it("retryDead re-queues only the failures whose answer can change", async () => {
    let online = false;
    const { calls, transport } = makeTransport([rlsErr, checkErr]);
    const box = createOutbox({ getDb, transport, isOnline: () => online });

    await box.enqueue({ kind: "insert", table: "sets", payload: setA });
    await box.enqueue({ kind: "insert", table: "sets", payload: setB });
    online = true;
    await box.flush();
    expect(box.getStatus().dead).toBe(2);

    const outcome = await box.retryDead();
    // setA was refused by a policy, which a replay can get past. setB was
    // refused by a check constraint, which it cannot — re-queueing that one
    // only moves it from FAILED to FAILED via a moment of false hope.
    expect(outcome).toEqual({ requeued: 1, stuck: 1 });
    expect(box.getStatus()).toMatchObject({ pending: 0, dead: 1, held: 0 });

    const sent = calls.map((c) => (c.payload as SetInsert).id);
    expect(sent.filter((id) => id === setA.id)).toHaveLength(2);
    expect(sent.filter((id) => id === setB.id)).toHaveLength(1);

    // It stays in IndexedDB, exportable, rather than being dropped.
    const remaining = await box.inspect();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ cause: "rejected", retryable: false });
  });

  it("retryDead leaves another user's held work exactly where it is", async () => {
    let who: string | null = BOB;
    let online = false;
    const { calls, transport } = makeTransport();
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => online,
      currentUserId: () => who,
    });

    await box.enqueue({ kind: "insert", table: "sets", payload: setB });
    who = ALICE;
    online = true;

    // Retry is a verb aimed at DEAD items. A held item is pending and healthy,
    // and re-queueing it would be the one thing that could send Bob's set as
    // Alice — permanently, because `sets` is append-only.
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 0 });
    expect(calls).toHaveLength(0);
    await box.flush();
    expect(calls).toHaveLength(0);

    const db = await getDb();
    const rows = await db.getAll("outbox");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(BOB);
    expect(rows[0].status).toBe("pending");
    expect(box.getStatus()).toMatchObject({ pending: 1, held: 1, dead: 0 });
  });

  it("a dead item with no recorded cause is still offered a retry", async () => {
    // Items that died before the code and status were kept carry only the
    // message. Refusing to try on no evidence is the worse of the two guesses:
    // the write is real and the server may well take it now.
    const { calls, transport } = makeTransport();
    const db = await getDb();
    await db.add("outbox", {
      op: { kind: "insert", table: "sets", payload: setA },
      created_at: "2026-08-25T10:00:00.000Z",
      retries: 4,
      last_error: "permission denied for table sets",
      status: "dead",
    });
    const box = createOutbox({ getDb, transport, isOnline: () => true });

    const entries = await box.inspect();
    expect(entries[0]).toMatchObject({ cause: "unknown", retryable: true });

    expect(await box.retryDead()).toEqual({ requeued: 1, stuck: 0 });
    expect(calls).toHaveLength(1);
  });

  // onSynced: the hook a caller uses to react to a write actually reaching the
  // server, as opposed to merely being queued. The checkin-memory extraction
  // route is fire-and-forget and must run AFTER the note is on the server —
  // firing it on enqueue would ask about a check-in the server has not seen
  // yet, offline or not.
  describe("onSynced", () => {
    it("is called with the op once it actually reaches the server", async () => {
      let online = false;
      const { transport } = makeTransport();
      const synced: OutboxOp[] = [];
      const box = createOutbox({
        getDb,
        transport,
        isOnline: () => online,
        onSynced: (op) => synced.push(op),
      });
      await box.enqueue({ kind: "insert", table: "sets", payload: setA });
      await box.flush(); // drain the enqueue-triggered flush while offline
      expect(synced).toEqual([]);
      online = true;
      await box.flush();
      expect(synced).toEqual([
        { kind: "insert", table: "sets", payload: setA },
      ]);
    });

    it("is not called for an item that stays pending (offline/retryable)", async () => {
      let online = false;
      const { transport } = makeTransport([netErr()]);
      const synced: OutboxOp[] = [];
      const box = createOutbox({
        getDb,
        transport,
        isOnline: () => online,
        onSynced: (op) => synced.push(op),
      });
      await box.enqueue({ kind: "insert", table: "sets", payload: setA });
      await box.flush(); // drain the enqueue-triggered flush while offline
      online = true;
      await box.flush();
      expect(synced).toEqual([]);
    });

    it("is not called for an item the server refuses (dead)", async () => {
      let online = false;
      const { transport } = makeTransport([checkErr]);
      const synced: OutboxOp[] = [];
      const box = createOutbox({
        getDb,
        transport,
        isOnline: () => online,
        onSynced: (op) => synced.push(op),
      });
      await box.enqueue({ kind: "insert", table: "sets", payload: setA });
      await box.flush(); // drain the enqueue-triggered flush while offline
      online = true;
      await box.flush();
      expect(synced).toEqual([]);
    });

    it("fires once per item for a batch, in replay order", async () => {
      let online = false;
      const { transport } = makeTransport();
      const synced: string[] = [];
      const box = createOutbox({
        getDb,
        transport,
        isOnline: () => online,
        onSynced: (op) => {
          if (op.kind === "insert" && op.table === "sets") {
            synced.push((op.payload as SetInsert).id);
          }
        },
      });
      await box.enqueue({ kind: "insert", table: "sets", payload: setA });
      await box.enqueue({ kind: "insert", table: "sets", payload: setB });
      await box.flush(); // drain the enqueue-triggered flushes while offline
      online = true;
      await box.flush();
      expect(synced).toEqual([setA.id, setB.id]);
    });
  });
});


describe("successful operation subscribers", () => {
  const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
  const BOB = "bbbbbbbb-2222-4222-8222-222222222222";

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
  });

  it("reports the owner captured for the request if identity changes before its ACK", async () => {
    let who: string | null = ALICE;
    let finishRequest: ((error: TransportError | null) => void) | undefined;
    const calls: Call[] = [];
    const transport: OutboxTransport = {
      async insert(table, payload) {
        calls.push({ kind: "insert", table, payload });
        return await new Promise((resolve) => { finishRequest = resolve; });
      },
      async update() { return null; },
    };
    const legacyCallback = vi.fn();
    const box = createOutbox({
      getDb, transport, isOnline: () => true,
      currentUserId: () => who, stampUserId: () => who,
      onSynced: legacyCallback,
    });
    const op: OutboxOp = { kind: "insert", table: "sets", payload: makeSet("44444444-4444-4444-8444-444444444444", 0) };
    await box.enqueue(op);
    const events: Array<{ op: OutboxOp; ownerId: string | null | undefined }> = [];
    const unsubscribe = box.subscribeSynced((syncedOp, ownerId) => events.push({ op: syncedOp, ownerId }));
    const flush = box.flush();
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf("function"));
    who = BOB;
    finishRequest?.(null);
    await flush;
    unsubscribe();

    expect(events).toEqual([{ op, ownerId: ALICE }]);
    expect(legacyCallback).toHaveBeenCalledWith(op);
    expect(calls).toHaveLength(1);
  });

  it("passes the durable correction relation with its exact void ACK", async () => {
    let online = false;
    let who: string | null = ALICE;
    const { calls, transport } = makeTransport();
    const legacyCallback = vi.fn();
    const box = createOutbox({
      getDb, transport, isOnline: () => online,
      currentUserId: () => who, stampUserId: () => who,
      onSynced: legacyCallback,
    });
    const replacement = makeSet("66666666-6666-4666-8666-666666666666", 0);
    const originalId = "77777777-7777-4777-8777-777777777777";
    const expectedLink = { session_id: session.id, replacement_id: replacement.id, original_id: originalId };
    const events: Array<{ op: OutboxOp; ownerId: string | null | undefined; correctionLink?: typeof expectedLink }> = [];
    box.subscribeSynced((op, ownerId, correctionLink) => events.push({ op, ownerId, correctionLink }));
    box.subscribeSynced(() => { throw new Error("receipt observer failed"); });

    await box.enqueueCorrection(session.id, replacement, originalId);
    await box.flush(); // drain the enqueue-triggered flush while offline
    online = true;
    await box.flush();

    expect(calls.map((call) => call.table)).toEqual(["sets", "set_voids"]);
    expect(events).toEqual([
      { op: { kind: "insert", table: "sets", payload: replacement }, ownerId: ALICE, correctionLink: expectedLink },
      { op: { kind: "insert", table: "set_voids", payload: { set_id: originalId } }, ownerId: ALICE, correctionLink: expectedLink },
    ]);
    expect(legacyCallback).toHaveBeenCalledTimes(2);
    expect(await box.inspect()).toEqual([]);
  });

  it("stops retrying an owner's item if auth changes during refresh", async () => {
    let who: string | null = ALICE;
    const { calls, transport } = makeTransport([authErr]);
    const box = createOutbox({
      getDb, transport, isOnline: () => true,
      currentUserId: () => who, stampUserId: () => who,
      onIdentityChange: () => () => undefined,
    });
    transport.refreshAuth = async () => { who = BOB; return true; };
    await box.enqueue({ kind: "insert", table: "sets", payload: makeSet("55555555-5555-4555-8555-555555555555", 0) });
    await box.flush();

    expect(calls).toHaveLength(1);
    expect(await box.inspect()).toMatchObject([{ user_id: ALICE, state: "held" }]);
  });


  describe("load integrity gate", () => {
    const bad: SetInsert = {
      ...setA,
      load_kg: 100,
      load_entry: "total",
      entered_load: 220.5,
      entered_unit: "lb",
    };
    const good: SetInsert = { ...setB, load_kg: 102.06, load_entry: "total", entered_load: 225, entered_unit: "lb" };

    it("refuses a set the database would refuse, on every enqueue path, and queues nothing", async () => {
      const { calls, transport } = makeTransport();
      const box = createOutbox({ getDb, transport, isOnline: () => false });
      await expect(box.enqueue({ kind: "insert", table: "sets", payload: bad })).rejects.toMatchObject({
        name: "LoadIntegrityError",
        code: "mismatch",
      });
      await expect(box.enqueueBatch([
        { kind: "insert", table: "sets", payload: good },
        { kind: "insert", table: "sets", payload: bad },
      ])).rejects.toMatchObject({ name: "LoadIntegrityError" });
      await expect(box.enqueueCorrection("s1", bad, "old-id")).rejects.toMatchObject({
        name: "LoadIntegrityError",
      });
      expect(await box.inspect()).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("accepts consistent authored sets and legacy sets without provenance", async () => {
      const { transport } = makeTransport();
      const box = createOutbox({ getDb, transport, isOnline: () => false });
      await box.enqueue({ kind: "insert", table: "sets", payload: good });
      await box.enqueue({ kind: "insert", table: "sets", payload: { ...setA, load_kg: 61.2345 } });
      expect(await box.inspect()).toHaveLength(2);
    });
  });
});
