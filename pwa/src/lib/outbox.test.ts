import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutbox,
  deadKind,
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
      held: 0,
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
    expect(entries.map((e) => e.key)).toEqual([...entries.map((e) => e.key)].sort((a, b) => a - b));
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
});
