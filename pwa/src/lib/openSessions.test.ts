// `syncOpenSessions` (lib/data.ts) — the overnight sweep. It auto-completes
// yesterday's forgotten session, auto-discards an empty one, clears a stale
// active pointer and surfaces an orphan for adoption. Every one of those is
// a write against real training data, and until the port was injectable none
// of it could be exercised without a database.
//
// The matrix below was captured against the pre-injection implementation, so
// it proves the refactor preserved behaviour rather than describing new
// behaviour. The exception is the auto-discard ownership rule: discarding
// now requires the active pointer, because only the device that STARTED a
// session can read "no sets" as anything but "no sets HERE". The cases that
// discard therefore pass an activeId where they used to pass null.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  syncOpenSessions,
  type OpenSessionPort,
  type OpenSessionRow,
} from "./data";
import { cacheGet, cacheKeys, cacheSet, resetDbForTests } from "./db";

const TODAY = "2026-08-27";
/** the device's local calendar day for a timestamp; fixtures use UTC noon */
const localDayOf = (iso: string) => iso.slice(0, 10);

const session = (over: Partial<OpenSessionRow> = {}): OpenSessionRow => ({
  id: "sess-old",
  planned_workout_id: "pw1",
  started_at: "2026-08-26T18:00:00.000Z",
  ...over,
});

interface PortCall {
  op: "complete" | "discard";
  id: string;
  at: string;
}

/** Port over plain fixtures. `lastSets` maps session id -> newest set time.
 *  `queued` maps session id -> sets still waiting in this device's outbox. */
function makePort(
  open: OpenSessionRow[],
  lastSets: Record<string, string> = {},
  closed: Record<
    string,
    { ended_at: string | null; discarded_at: string | null } | null
  > = {},
  queued: Record<string, number> = {},
) {
  const calls: PortCall[] = [];
  const port: OpenSessionPort = {
    async listOpen() {
      return open;
    },
    async lastSetAt(id) {
      return lastSets[id] ?? null;
    },
    async complete(id, endedAt) {
      calls.push({ op: "complete", id, at: endedAt });
    },
    async discard(id, discardedAt) {
      calls.push({ op: "discard", id, at: discardedAt });
    },
    async closedState(id) {
      return closed[id] ?? null;
    },
    async queuedSetCount(id) {
      return queued[id] ?? 0;
    },
  };
  return { port, calls };
}

beforeEach(async () => {
  // fake-indexeddb keeps state between tests otherwise, and these assertions
  // are about what survives in the cache
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  await cacheSet(cacheKeys.doneWorkouts("prog1"), ["pw1"]);
});

describe("syncOpenSessions", () => {
  // The bug this guards: "empty" was read off the SERVER alone. A session
  // logged offline has no server-side sets yet, so yesterday's real workout
  // was soft-deleted and the sets then flushed into a discarded session —
  // invisible in every view, and the PWA has no un-discard.
  it("leaves a session ALONE while its sets are still queued locally", async () => {
    const s = session();
    const { port, calls } = makePort([s], {}, {}, { [s.id]: 3 });
    const r = await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(calls).toEqual([]);
    expect(r.autoDiscarded).toBe(0);
    expect(r.autoCompleted).toBe(0);
  });

  it("does not auto-complete early when sets are still queued", async () => {
    // the server knows about an early set; the device holds later ones, so
    // completing now would stamp ended_at before the session really ended
    const s = session();
    const { port, calls } = makePort(
      [s],
      { [s.id]: "2026-08-26T18:30:00.000Z" },
      {},
      { [s.id]: 1 },
    );
    await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(calls).toEqual([]);
  });

  it("still discards a session the device agrees is empty", async () => {
    // "agrees" now means the device that STARTED it: it holds the active
    // pointer, so an empty outbox here really is that session's outbox
    const s = session();
    const { port, calls } = makePort([s], {}, {}, { [s.id]: 0 });
    const r = await syncOpenSessions(s.id, localDayOf, TODAY, new Set(), port);
    expect(r.autoDiscarded).toBe(1);
    expect(calls[0]?.op).toBe("discard");
  });

  it("auto-completes yesterday's session AT ITS LAST SET", async () => {
    const s = session();
    const last = "2026-08-26T19:12:00.000Z";
    const { port, calls } = makePort([s], { [s.id]: last });
    const r = await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(r).toEqual({
      autoCompleted: 1,
      autoDiscarded: 0,
      clearedActive: false,
      orphan: null,
    });
    expect(calls).toEqual([{ op: "complete", id: s.id, at: last }]);
  });

  it("clamps ended_at forward when the last set predates started_at", async () => {
    // the DB check is ended_at >= started_at; a clock change must not make
    // the sweep write a row Postgres rejects
    const s = session({ started_at: "2026-08-26T20:00:00.000Z" });
    const { port, calls } = makePort([s], {
      [s.id]: "2026-08-26T18:00:00.000Z",
    });
    await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(calls[0].at).toBe(s.started_at);
  });

  it("auto-DISCARDS yesterday's session when it logged nothing", async () => {
    // an accidental start must not mark the planned workout done — on the
    // device that made it, which is the one holding the active pointer
    const s = session();
    const { port, calls } = makePort([s]);
    const r = await syncOpenSessions(s.id, localDayOf, TODAY, new Set(), port);
    expect(r.autoDiscarded).toBe(1);
    expect(r.autoCompleted).toBe(0);
    expect(calls[0].op).toBe("discard");
    // the week's DONE state referenced that session
    expect(await cacheGet(cacheKeys.doneWorkouts("prog1"))).toBeUndefined();
  });

  // The second half of the same bug. "Empty" was read off the server AND
  // this device's outbox, which is the whole truth on one device and a
  // half-truth on two: the phone that logged 25 sets at the gym is still
  // offline, so from the iPad the session looks like an accidental start.
  it("leaves ANOTHER device's apparently-empty session open", async () => {
    const s = session(); // started on the phone yesterday, never synced
    const { port, calls } = makePort([s], {}, {}, { [s.id]: 0 });
    const r = await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(calls).toEqual([]);
    expect(r.autoDiscarded).toBe(0);
    expect(r.autoCompleted).toBe(0);
    // the week's DONE state is untouched: nothing about that day changed
    expect(await cacheGet(cacheKeys.doneWorkouts("prog1"))).toEqual(["pw1"]);
  });

  it("leaves it open even while this device owns a DIFFERENT session", async () => {
    // holding a pointer at some other session is not evidence about this one
    const s = session();
    const { port, calls } = makePort([s]);
    const r = await syncOpenSessions(
      "sess-mine",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(calls).toEqual([]);
    expect(r.autoDiscarded).toBe(0);
  });

  it("still discards the device's OWN empty session from yesterday", async () => {
    // the guard is about foreign sessions only: an accidental start on THIS
    // device must still not leave the planned day looking trained
    const s = session();
    const { port, calls } = makePort([s]);
    const r = await syncOpenSessions(s.id, localDayOf, TODAY, new Set(), port);
    expect(r.autoDiscarded).toBe(1);
    expect(calls).toEqual([
      { op: "discard", id: s.id, at: expect.any(String) },
    ]);
    expect(r.clearedActive).toBe(true);
  });

  it("auto-completes ANOTHER device's session once its sets have landed", async () => {
    // completing stays cross-device: sets arriving later still belong to the
    // session, and the phone that started it may never open the app again
    const s = session();
    const last = "2026-08-26T19:12:00.000Z";
    const { port, calls } = makePort([s], { [s.id]: last });
    const r = await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(r.autoCompleted).toBe(1);
    expect(r.autoDiscarded).toBe(0);
    expect(calls).toEqual([{ op: "complete", id: s.id, at: last }]);
  });

  it("leaves a session with a QUEUED end/discard completely alone", async () => {
    // the server hasn't heard yet; touching it would fight the outbox
    const s = session();
    const { port, calls } = makePort([s], { [s.id]: "2026-08-26T19:00:00Z" });
    const r = await syncOpenSessions(
      null,
      localDayOf,
      TODAY,
      new Set([s.id]),
      port,
    );
    expect(calls).toEqual([]);
    expect(r).toEqual({
      autoCompleted: 0,
      autoDiscarded: 0,
      clearedActive: false,
      orphan: null,
    });
  });

  it("clears the active pointer when the server says that session is closed", async () => {
    await cacheSet(cacheKeys.activeSession, { id: "sess-x" });
    const { port } = makePort(
      [],
      {},
      {
        "sess-x": { ended_at: "2026-08-26T20:00:00.000Z", discarded_at: null },
      },
    );
    const r = await syncOpenSessions(
      "sess-x",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(r.clearedActive).toBe(true);
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });

  it("does NOT clear the pointer for a session the server has never seen", async () => {
    // its insert may still be queued in the outbox — missing is not closed
    await cacheSet(cacheKeys.activeSession, { id: "sess-new" });
    const { port } = makePort([]);
    const r = await syncOpenSessions(
      "sess-new",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(r.clearedActive).toBe(false);
    expect(await cacheGet(cacheKeys.activeSession)).toEqual({ id: "sess-new" });
  });

  it("surfaces a same-day open session this device does not own as an orphan", async () => {
    const s = session({ id: "sess-today", started_at: `${TODAY}T09:00:00Z` });
    const { port, calls } = makePort([s]);
    const r = await syncOpenSessions(null, localDayOf, TODAY, new Set(), port);
    expect(r.orphan).toEqual(s);
    expect(calls).toEqual([]); // today's business is never auto-closed
  });

  it("does not call the device's OWN active session an orphan", async () => {
    const s = session({ id: "sess-today", started_at: `${TODAY}T09:00:00Z` });
    const { port } = makePort([s]);
    const r = await syncOpenSessions(
      "sess-today",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(r.orphan).toBeNull();
  });

  it("DOES surface it once the active pointer has been invalidated", async () => {
    // pointer cleared => nothing owns that open session any more
    await cacheSet(cacheKeys.activeSession, { id: "sess-stale" });
    const s = session({ id: "sess-today", started_at: `${TODAY}T09:00:00Z` });
    const { port } = makePort(
      [s],
      {},
      {
        "sess-stale": { ended_at: null, discarded_at: "2026-08-26T20:00:00Z" },
      },
    );
    const r = await syncOpenSessions(
      "sess-stale",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(r.clearedActive).toBe(true);
    expect(r.orphan).toEqual(s);
  });

  it("handles a mixed batch: sweep the stale ones, surface today's", async () => {
    const withSets = session({ id: "a" });
    const empty = session({ id: "b" });
    const todays = session({ id: "c", started_at: `${TODAY}T08:00:00Z` });
    const { port, calls } = makePort([withSets, empty, todays], {
      a: "2026-08-26T19:30:00.000Z",
    });
    // "b" is this device's own start, so the empty one is ours to discard
    const r = await syncOpenSessions("b", localDayOf, TODAY, new Set(), port);
    expect(r.autoCompleted).toBe(1);
    expect(r.autoDiscarded).toBe(1);
    expect(r.orphan).toEqual(todays);
    expect(calls.map((c) => `${c.op}:${c.id}`)).toEqual([
      "complete:a",
      "discard:b",
    ]);
  });

  it("clears the active pointer when the sweep closed that very session", async () => {
    await cacheSet(cacheKeys.activeSession, { id: "sess-old" });
    const s = session();
    const { port } = makePort([s], { [s.id]: "2026-08-26T19:00:00.000Z" });
    const r = await syncOpenSessions(
      "sess-old",
      localDayOf,
      TODAY,
      new Set(),
      port,
    );
    expect(r.clearedActive).toBe(true);
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });
});
