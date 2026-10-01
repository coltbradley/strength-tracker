// Exercise-pref sync: the last-write-wins merge, the exact shape of the queued
// write (through the real outbox), and the rule that one account's prefs are
// never uploaded as another's.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  comparePrefValues,
  createExercisePrefsSync,
  mergeExercisePrefs,
  pendingKey,
  prefToUpsert,
  rowToPref,
  type ExercisePrefsSync,
  type ExercisePrefsSyncDeps,
} from "./exercisePrefsSync";
import {
  clearExercisePref,
  getExercisePref,
  getExercisePrefsSyncState,
  getSetting,
  listExercisePrefs,
  dropRefusedExercisePref,
  pruneExercisePrefs,
  reloadSettings,
  replaceExercisePrefsState,
  setExercisePref,
  setExerciseLoadStyle,
} from "./settings";
import { createOutbox, type OutboxTransport } from "./outbox";
import { getDb, resetDbForTests, type OutboxOp } from "./db";
import type { ExercisePrefRow } from "./types";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-0000000000b0";
const T0 = "2026-10-01T08:00:00.000Z";
const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-01T10:00:00.000Z";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

function row(
  exercise_id: string,
  updated_at: string,
  over: Partial<ExercisePrefRow> = {},
): ExercisePrefRow {
  return {
    exercise_id,
    bar_kg: null,
    rest_seconds: null,
    load_step_kg: null,
    load_unit: null,
    load_entry: null,
    load_style: null,
    updated_at,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  reloadSettings();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---- the merge ---------------------------------------------------------------

describe("mergeExercisePrefs (last-write-wins by updated_at)", () => {
  it("takes a server row newer than the device's stamp", () => {
    const r = mergeExercisePrefs(
      { sled: { barKg: 20 } },
      { sled: T0 },
      [row("sled", T1, { bar_kg: 34, load_style: "plates" })],
      T2,
    );
    expect(r.prefs.sled).toEqual({ barKg: 34, loadStyle: "plates" });
    expect(r.stamps.sled).toBe(T1);
    expect(r.uploads).toEqual([]);
  });

  it("keeps and uploads a device choice newer than the server's", () => {
    const r = mergeExercisePrefs(
      { sled: { barKg: 40 } },
      { sled: T2 },
      [row("sled", T1, { bar_kg: 34 })],
      NOW.toString(),
    );
    expect(r.prefs.sled).toEqual({ barKg: 40 });
    expect(r.uploads).toEqual([
      { exerciseId: "sled", pref: { barKg: 40 }, updatedAt: T2 },
    ]);
  });

  it("does nothing when both sides carry the same stamp", () => {
    const r = mergeExercisePrefs(
      { db: { loadEntry: "per_side" } },
      { db: T1 },
      [row("db", T1, { load_entry: "per_side" })],
      T2,
    );
    expect(r.prefs).toEqual({ db: { loadEntry: "per_side" } });
    expect(r.uploads).toEqual([]);
  });

  it("a newer server tombstone clears the device pref", () => {
    const r = mergeExercisePrefs({ sled: { barKg: 20 } }, { sled: T0 }, [row("sled", T1)], T2);
    expect(r.prefs.sled).toBeUndefined();
    expect(r.stamps.sled).toBe(T1);
  });

  it("a newer DEVICE tombstone is uploaded and an older server value cannot resurrect it", () => {
    const r = mergeExercisePrefs({}, { sled: T2 }, [row("sled", T1, { bar_kg: 34 })], T2);
    expect(r.prefs.sled).toBeUndefined();
    expect(r.uploads).toEqual([{ exerciseId: "sled", pref: null, updatedAt: T2 }]);
  });

  it("an unstamped (pre-sync) device pref loses to any server row", () => {
    const r = mergeExercisePrefs({ sled: { barKg: 20 } }, {}, [row("sled", T0, { bar_kg: 34 })], T2);
    expect(r.prefs.sled).toEqual({ barKg: 34 });
    expect(r.uploads).toEqual([]);
  });

  it("uploads a pref the server has never seen, stamping a pre-sync one now", () => {
    const r = mergeExercisePrefs({ legacy: { barKg: 15 }, fresh: { restSeconds: 90 } }, { fresh: T1 }, [], T2);
    expect(r.stamps.legacy).toBe(T2);
    expect(r.uploads).toEqual([
      { exerciseId: "legacy", pref: { barKg: 15 }, updatedAt: T2 },
      { exerciseId: "fresh", pref: { restSeconds: 90 }, updatedAt: T1 },
    ]);
  });

  it("compares instants, not strings (Postgres renders +00:00, not Z)", () => {
    const r = mergeExercisePrefs(
      { sled: { barKg: 40 } },
      { sled: "2026-10-01T10:00:00.000Z" },
      [row("sled", "2026-10-01T09:30:00+00:00", { bar_kg: 34 })],
      T2,
    );
    expect(r.prefs.sled).toEqual({ barKg: 40 });
    expect(r.uploads).toHaveLength(1);
  });
});

describe("row <-> pref", () => {
  it("round-trips every field, and an all-null row is a tombstone", () => {
    const pref = {
      barKg: 20.4116,
      restSeconds: 180,
      loadStepKg: 2.5,
      loadUnit: "lb" as const,
      loadEntry: "per_side" as const,
      loadStyle: "stack" as const,
    };
    const up = prefToUpsert(ALICE, "x", pref, T1);
    expect(rowToPref(up)).toEqual(pref);
    expect(rowToPref(row("x", T1))).toBeNull();
  });
});

// ---- settings-side stamping ----------------------------------------------------

describe("settings stamps each local per-exercise change", () => {
  it("stamps a set and a clear, monotonic even if the clock steps back", () => {
    setExercisePref("sled", { barKg: 34 });
    const first = getExercisePrefsSyncState().stamps.sled;
    expect(first).toBe(new Date(NOW).toISOString());
    vi.setSystemTime(NOW - 60_000);
    clearExercisePref("sled");
    const second = getExercisePrefsSyncState().stamps.sled;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    // the clear is a tombstone: stamped, but no empty override is listed
    expect(listExercisePrefs()).toEqual([]);
  });

  it("re-choosing the same value is not a change", () => {
    setExerciseLoadStyle("sled", "stack");
    const stamp = getExercisePrefsSyncState().stamps.sled;
    vi.setSystemTime(NOW + 5_000);
    setExerciseLoadStyle("sled", "stack");
    expect(getExercisePrefsSyncState().stamps.sled).toBe(stamp);
  });

  it("prune drops the stamps of exercises that are gone", () => {
    setExercisePref("ghost", { barKg: 0 });
    setExercisePref("sled", { barKg: 34 });
    pruneExercisePrefs(["sled"]);
    expect(Object.keys(getExercisePrefsSyncState().stamps)).toEqual(["sled"]);
  });

  it("the sync state survives a reload of the envelope", () => {
    replaceExercisePrefsState({ sled: { barKg: 34 } }, { owner: ALICE, stamps: { sled: T1 } });
    reloadSettings();
    expect(getExercisePrefsSyncState()).toEqual({ owner: ALICE, stamps: { sled: T1 } });
    expect(getExercisePref("sled")).toEqual({ barKg: 34 });
  });
});

// ---- the sync loop -------------------------------------------------------------

interface Harness {
  sync: ExercisePrefsSync;
  enqueued: OutboxOp[];
  reports: unknown[];
  setUser: (id: string | null) => void;
  setRows: (rows: ExercisePrefRow[] | Error) => void;
  fetchCalls: () => number;
}

function harness(over: Partial<ExercisePrefsSyncDeps> = {}): Harness {
  let user: string | null = null;
  let rows: ExercisePrefRow[] | Error = [];
  let calls = 0;
  const listeners = new Set<(id: string | null) => void>();
  const enqueued: OutboxOp[] = [];
  const reports: unknown[] = [];
  const sync = createExercisePrefsSync({
    fetchRows: async () => {
      calls += 1;
      if (rows instanceof Error) throw rows;
      return rows;
    },
    enqueue: async (ops) => {
      enqueued.push(...ops);
    },
    pendingKeys: async () =>
      new Set(
        enqueued.flatMap((op) =>
          op.kind === "insert" && op.table === "exercise_prefs"
            ? [pendingKey(op.payload.exercise_id, op.payload.updated_at)]
            : [],
        ),
      ),
    currentUserId: () => user,
    onUserChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    report: (e) => reports.push(e),
    now: () => Date.now(),
    ...over,
  });
  return {
    sync,
    enqueued,
    reports,
    setUser(id) {
      user = id;
      for (const fn of listeners) fn(id);
    },
    setRows(r) {
      rows = r;
    },
    fetchCalls: () => calls,
  };
}

let active: Harness | null = null;
afterEach(() => {
  active?.sync.stop();
  active = null;
});

describe("exercise-pref sync: writes", () => {
  it("queues a local change as a full-row upsert stamped with its owner and time", async () => {
    const h = (active = harness());
    h.sync.start();
    h.setUser(ALICE);
    await h.sync.reconcile();

    setExercisePref("sled", { barKg: 34, loadStyle: "plates" });
    await Promise.resolve();
    expect(h.enqueued).toEqual([
      {
        kind: "insert",
        table: "exercise_prefs",
        payload: {
          user_id: ALICE,
          exercise_id: "sled",
          bar_kg: 34,
          rest_seconds: null,
          load_step_kg: null,
          load_unit: null,
          load_entry: null,
          load_style: "plates",
          updated_at: new Date(NOW).toISOString(),
        },
      },
    ]);

    vi.setSystemTime(NOW + 1000);
    clearExercisePref("sled");
    await Promise.resolve();
    const last = h.enqueued.at(-1);
    expect(last?.kind === "insert" && last.table === "exercise_prefs" && last.payload).toMatchObject({
      exercise_id: "sled",
      bar_kg: null,
      load_style: null,
      updated_at: new Date(NOW + 1000).toISOString(),
    });
  });

  it("queues nothing while identity is unknown, and the next reconcile carries it", async () => {
    const h = (active = harness());
    h.sync.start();
    await Promise.resolve();
    setExercisePref("db-press", { loadEntry: "per_side" });
    await Promise.resolve();
    expect(h.enqueued).toEqual([]);

    h.setUser(ALICE); // identity arrives -> reconcile
    await h.sync.reconcile();
    expect(h.enqueued).toHaveLength(1);
    const op = h.enqueued[0];
    expect(op.kind === "insert" && op.table === "exercise_prefs" && op.payload).toMatchObject({
      user_id: ALICE,
      exercise_id: "db-press",
      load_entry: "per_side",
    });
  });

  it("does not queue a second copy of a write already waiting in the outbox", async () => {
    const h = (active = harness());
    h.sync.start();
    h.setUser(ALICE);
    await h.sync.reconcile();
    setExercisePref("sled", { barKg: 34 });
    await Promise.resolve();
    await h.sync.reconcile(); // server still empty: the write is merely queued
    expect(h.enqueued).toHaveLength(1);
  });

  it("merges the server's newer rows into the device", async () => {
    const h = (active = harness());
    replaceExercisePrefsState({ sled: { barKg: 20 } }, { owner: ALICE, stamps: { sled: T0 } });
    h.setRows([row("sled", T1, { bar_kg: 34 }), row("db", T1, { load_entry: "per_side" })]);
    h.setUser(ALICE);
    await h.sync.reconcile();
    expect(getExercisePref("sled")).toEqual({ barKg: 34 });
    expect(getExercisePref("db")).toEqual({ loadEntry: "per_side" });
    expect(h.enqueued).toEqual([]); // a merge never echoes back
  });

  it("an offline read changes nothing and is handed to the reporter", async () => {
    const h = (active = harness());
    replaceExercisePrefsState({ sled: { barKg: 20 } }, { owner: ALICE, stamps: { sled: T0 } });
    h.setRows(new Error("offline"));
    h.setUser(ALICE);
    await h.sync.reconcile();
    expect(getExercisePref("sled")).toEqual({ barKg: 20 });
    expect(h.enqueued).toEqual([]);
    expect(h.reports).toHaveLength(1);
  });
});

describe("exercise-pref sync: a different account is never sent the previous one's prefs", () => {
  it("drops the previous owner's prefs before fetching, and uploads none of them", async () => {
    const h = (active = harness());
    replaceExercisePrefsState(
      { sled: { barKg: 34 }, db: { loadEntry: "per_side" } },
      { owner: ALICE, stamps: { sled: T2, db: T2 } },
    );
    h.setRows([row("bench", T0, { bar_kg: 20 })]);
    h.setUser(BOB);
    await h.sync.reconcile();
    expect(getExercisePrefsSyncState().owner).toBe(BOB);
    expect(getSetting("exercisePrefs")).toEqual({ bench: { barKg: 20 } });
    expect(h.enqueued).toEqual([]);
  });

  it("drops the previous owner's prefs even when the new account is offline", async () => {
    const h = (active = harness());
    replaceExercisePrefsState({ sled: { barKg: 34 } }, { owner: ALICE, stamps: { sled: T2 } });
    h.setRows(new Error("offline"));
    h.setUser(BOB);
    await h.sync.reconcile();
    expect(getExercisePrefsSyncState()).toEqual({ owner: BOB, stamps: {} });
    expect(getSetting("exercisePrefs")).toEqual({});
    expect(h.enqueued).toEqual([]);
  });

  it("refuses to queue while the device prefs still belong to someone else", async () => {
    const h = (active = harness({ onUserChange: undefined }));
    h.sync.start();
    replaceExercisePrefsState({}, { owner: ALICE, stamps: {} });
    h.setUser(BOB); // no listener wired: no reconcile has claimed for Bob
    setExercisePref("sled", { barKg: 34 });
    await Promise.resolve();
    expect(h.enqueued).toEqual([]);
  });

  it("rows that arrive after the user changed mid-fetch are not merged", async () => {
    let release: (rows: ExercisePrefRow[]) => void = () => {};
    let user: string | null = ALICE;
    const enqueued: OutboxOp[] = [];
    const sync = createExercisePrefsSync({
      fetchRows: () => new Promise((r) => (release = r)),
      enqueue: async (ops) => void enqueued.push(...ops),
      pendingKeys: async () => new Set(),
      currentUserId: () => user,
      report: () => {},
    });
    replaceExercisePrefsState({}, { owner: ALICE, stamps: {} });
    const run = sync.reconcile();
    await Promise.resolve();
    user = BOB;
    release([row("sled", T1, { bar_kg: 34 })]);
    await run;
    expect(getSetting("exercisePrefs")).toEqual({});
    expect(enqueued).toEqual([]);
  });

  it("legacy unowned prefs are adopted by the first account and uploaded once", async () => {
    const h = (active = harness());
    setExercisePref("sled", { barKg: 34 }); // no identity yet: owner stays null
    expect(getExercisePrefsSyncState().owner).toBeNull();
    h.setUser(ALICE);
    await h.sync.reconcile();
    expect(getExercisePrefsSyncState().owner).toBe(ALICE);
    expect(h.enqueued).toHaveLength(1);
  });
});

// ---- audit fixes -------------------------------------------------------------

describe("equal stamps (F7)", () => {
  it("converge on the larger value on both sides, like the trigger", () => {
    const local = { sled: { barKg: 20 } };
    const r = mergeExercisePrefs(local, { sled: T1 }, [row("sled", T1, { bar_kg: 34 })], T2);
    expect(r.prefs.sled).toEqual({ barKg: 34 });
    expect(r.uploads).toEqual([]);
    const r2 = mergeExercisePrefs({ sled: { barKg: 34 } }, { sled: T1 }, [row("sled", T1, { bar_kg: 20 })], T2);
    expect(r2.prefs.sled).toEqual({ barKg: 34 });
    expect(r2.uploads).toEqual([{ exerciseId: "sled", pref: { barKg: 34 }, updatedAt: T1 }]);
  });

  it("orders absent below any value, then numbers, then strings", () => {
    expect(comparePrefValues({ barKg: 0 }, null)).toBeGreaterThan(0);
    expect(comparePrefValues({ loadStyle: "stack" }, { loadStyle: "plates" })).toBeGreaterThan(0);
    expect(comparePrefValues({ barKg: 20 }, { barKg: 20 })).toBe(0);
  });
});

describe("far-future stamps (F3)", () => {
  it("a device stamp beyond the server's bound is treated as unstamped", () => {
    const r = mergeExercisePrefs(
      { sled: { barKg: 20 } },
      { sled: "9999-12-31T00:00:00.000Z" },
      [row("sled", T1, { bar_kg: 34 })],
      new Date(NOW).toISOString(),
    );
    expect(r.prefs.sled).toEqual({ barKg: 34 });
    expect(r.stamps.sled).toBe(T1);
  });

  it("a new local choice does not build on an out-of-bound stamp", () => {
    replaceExercisePrefsState({}, { owner: null, stamps: { sled: "9999-12-31T00:00:00.000Z" } });
    setExercisePref("sled", { barKg: 34 });
    expect(getExercisePrefsSyncState().stamps.sled).toBe(new Date(NOW).toISOString());
  });
});

describe("a refused pref is forgotten, not re-queued forever (F1)", () => {
  it("drops the pref and stamp only if the refused stamp is still current", () => {
    replaceExercisePrefsState({ gone: { barKg: 20 }, kept: { barKg: 20 } }, { owner: ALICE, stamps: { gone: T1, kept: T2 } });
    expect(dropRefusedExercisePref("kept", T1)).toBe(false); // edited since
    expect(dropRefusedExercisePref("gone", T1)).toBe(true);
    expect(getExercisePref("gone")).toEqual({});
    expect(getExercisePrefsSyncState().stamps).toEqual({ kept: T2 });
  });

  it("does not enqueue a second copy while one is dead or waiting", async () => {
    const h = (active = harness());
    h.setUser(ALICE);
    replaceExercisePrefsState({ gone: { barKg: 20 } }, { owner: ALICE, stamps: { gone: T1 } });
    await h.sync.reconcile();
    await h.sync.reconcile();
    await h.sync.reconcile();
    expect(h.enqueued).toHaveLength(1);
  });

  it("through the real outbox: an FK or RLS refusal discards the item and the local pref", async () => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    const refusals = [
      { message: "violates foreign key constraint", code: "23503", status: 409 },
      { message: "new row violates row-level security policy", code: "42501", status: 403 },
    ];
    for (const err of refusals) {
      replaceExercisePrefsState({ gone: { barKg: 20 } }, { owner: ALICE, stamps: { gone: T1 } });
      const dropped: OutboxOp[] = [];
      let sends = 0;
      const outbox = createOutbox({
        getDb,
        transport: {
          async insert() {
            sends += 1;
            return err;
          },
          async update() {
            return null;
          },
        },
        isOnline: () => true,
        currentUserId: () => ALICE,
        onDiscarded: (op) => {
          dropped.push(op);
          if (op.kind === "insert" && op.table === "exercise_prefs") {
            dropRefusedExercisePref(op.payload.exercise_id, op.payload.updated_at);
          }
        },
      });
      await outbox.enqueue({
        kind: "insert",
        table: "exercise_prefs",
        payload: prefToUpsert(ALICE, "gone", { barKg: 20 }, T1),
      });
      await outbox.flush();
      expect(sends).toBe(1);
      expect(dropped).toHaveLength(1);
      expect(await outbox.inspect()).toEqual([]); // no dead pile
      expect(outbox.getStatus().dead).toBe(0);
      expect(getExercisePref("gone")).toEqual({});
      expect(getExercisePrefsSyncState().stamps).toEqual({});
    }
  });

  it("a bare permission-denied (role problem) or another table's FK is NOT discarded", async () => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    const outbox = createOutbox({
      getDb,
      transport: {
        async insert() {
          return { message: "permission denied for table exercise_prefs", code: "42501", status: 403 };
        },
        async update() {
          return null;
        },
      },
      isOnline: () => true,
      currentUserId: () => ALICE,
      onDiscarded: () => {
        throw new Error("should not be discarded");
      },
    });
    await outbox.enqueue({
      kind: "insert",
      table: "exercise_prefs",
      payload: prefToUpsert(ALICE, "x", { barKg: 20 }, T1),
    });
    await outbox.flush();
    expect(outbox.getStatus().dead).toBe(1);
  });
});

describe("identity claim and triggers (F5, F6)", () => {
  it("claims for a new account at once, even while the previous account's fetch hangs", async () => {
    let release: (r: ExercisePrefRow[]) => void = () => {};
    let first = true;
    const h = (active = harness({
      fetchRows: () => {
        if (first) {
          first = false;
          return new Promise<ExercisePrefRow[]>((res) => (release = res));
        }
        return Promise.resolve([]);
      },
    }));
    h.sync.start();
    h.setUser(ALICE);
    replaceExercisePrefsState({ sled: { barKg: 20 } }, { owner: ALICE, stamps: { sled: T1 } });
    const hung = h.sync.reconcile(); // Alice's read is in flight
    await new Promise((r) => setTimeout(r, 0));
    h.setUser(BOB);
    expect(getExercisePrefsSyncState().owner).toBe(BOB); // before any fetch returns
    expect(getExercisePref("sled")).toEqual({});
    release([]);
    await hung;
    await h.sync.reconcile();
    expect(h.enqueued).toEqual([]); // Alice's pref was never sent as Bob's
  });

  it("a failed read does not throttle the next foreground reconcile; online retries", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const h = (active = harness());
    h.setRows(new Error("offline"));
    h.setUser(ALICE);
    h.sync.start();
    await h.sync.reconcile();
    const failed = h.fetchCalls();
    h.setRows([]);
    win.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fetchCalls()).toBeGreaterThan(failed);
  });
});

// ---- through the real outbox -------------------------------------------------

describe("exercise-pref writes in the real outbox", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
  });

  it("are stamped with their owner, replayed as a merge, and held for anyone else", async () => {
    const inserts: Array<{ table: string; payload: unknown }> = [];
    const transport: OutboxTransport = {
      async insert(table, payload) {
        inserts.push({ table, payload });
        return null;
      },
      async update() {
        return null;
      },
    };
    let user: string | null = ALICE;
    const outbox = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => user,
    });
    const op: OutboxOp = {
      kind: "insert",
      table: "exercise_prefs",
      payload: prefToUpsert(ALICE, "sled", { barKg: 34 }, T1),
    };

    user = BOB; // queued as Alice's, but Bob is signed in now
    const db = await getDb();
    await db.add("outbox", {
      op,
      created_at: T1,
      retries: 0,
      last_error: null,
      status: "pending",
      user_id: ALICE,
    });
    await outbox.flush();
    expect(inserts).toEqual([]); // held, never sent as Bob
    expect(outbox.getStatus().held).toBe(1);

    user = ALICE;
    await outbox.flush();
    expect(inserts).toEqual([{ table: "exercise_prefs", payload: op.payload }]);
    expect((await outbox.inspect()).length).toBe(0);
  });
});
