// Cache invalidation is the one place in this app where forgetting something
// is silent. `End.tsx` used to carry a hand-copied prefix list, `History.tsx`
// two more, `Today.tsx` a fourth — and the asymmetry between them (a finished
// session dropped a different set of families than a discarded one) left the
// planned day reading as unfinished. `adherence:` appeared in none of them.
//
// These tests seed ONE kv entry per `cacheKeys` producer and pin the exact
// survivors of each verb. That is what makes the registry a registry: add a
// key and forget to place it in a family, and the survivor set no longer
// matches, so this fails rather than the app quietly serving stale data.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheClearAll,
  claimCacheFor,
  cacheGet,
  cacheKeys,
  cacheKeysWithPrefix,
  cacheFamilies,
  cacheSet,
  getDb,
  resetDbForTests,
} from "./db";
import { invalidateForSessionClose, invalidateForSetChange } from "./data";

const EX = "back_squat";
const SESS = "sess-1";
const PROG = "prog-1";
const PW = "pw-1";

/** One live kv entry for every key `cacheKeys` can produce. */
const ALL_KEYS: string[] = [
  cacheKeys.plannedWorkouts,
  cacheKeys.exercises,
  cacheKeys.activeSession,
  cacheKeys.lastActuals(),
  cacheKeys.lastActuals(SESS),
  cacheKeys.loggedExercises,
  cacheKeys.prescriptions(PW),
  cacheKeys.sessionRx(SESS),
  cacheKeys.sessionExtras(SESS),
  cacheKeys.sessionSets(SESS),
  cacheKeys.sessionVoids(SESS),
  cacheKeys.sessionSkips(SESS),
  cacheKeys.sessionSwaps(SESS),
  cacheKeys.sessionRest(SESS),
  cacheKeys.sessionSetNotes(SESS),
  cacheKeys.sessionEndDraft(SESS),
  cacheKeys.doneWorkouts(PROG),
  cacheKeys.e1rm(EX),
  cacheKeys.volume(EX),
  cacheKeys.goal(EX),
  cacheKeys.recentSets(EX),
  cacheKeys.sessionMeta(EX),
  cacheKeys.setNotes(EX),
  cacheKeys.adherence(EX),
  cacheKeys.trainingMaxes,
  cacheKeys.exerciseDemo(EX),
];

async function seedAll(): Promise<void> {
  for (const k of ALL_KEYS) await cacheSet(k, ["seeded"]);
}

async function survivors(): Promise<string[]> {
  const db = await getDb();
  return (await db.getAllKeys("kv"))
    .filter((k): k is string => typeof k === "string")
    .sort();
}

/** Session-scoped and plan-scoped entries: nothing set-derived. */
const UNTOUCHED = [
  cacheKeys.activeSession,
  cacheKeys.exercises,
  cacheKeys.plannedWorkouts,
  cacheKeys.prescriptions(PW),
  cacheKeys.sessionEndDraft(SESS),
  cacheKeys.sessionExtras(SESS),
  cacheKeys.sessionRest(SESS),
  cacheKeys.sessionRx(SESS),
  cacheKeys.sessionSets(SESS),
  cacheKeys.sessionSetNotes(SESS),
  cacheKeys.sessionSkips(SESS),
  cacheKeys.sessionSwaps(SESS),
  cacheKeys.sessionVoids(SESS),
  cacheKeys.trainingMaxes,
  cacheKeys.exerciseDemo(EX),
].sort();

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  await seedAll();
});

describe("cache families", () => {
  it("every cacheKeys producer writes a distinct key", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it("invalidateForSetChange drops every set-derived family and nothing else", async () => {
    await invalidateForSetChange();
    expect(await survivors()).toEqual(
      [...UNTOUCHED, cacheKeys.doneWorkouts(PROG)].sort(),
    );
  });

  it("invalidateForSessionClose additionally drops the week's DONE state", async () => {
    await invalidateForSessionClose();
    expect(await survivors()).toEqual(UNTOUCHED);
  });

  it("adherence: is invalidated — it used to be in no list at all", async () => {
    await invalidateForSetChange();
    expect(await cacheGet(cacheKeys.adherence(EX))).toBeUndefined();
  });

  it("FINISH and DISCARD leave identical survivors except doneWorkouts:", async () => {
    // the regression test for the bug End.tsx's comment records
    await invalidateForSetChange(); // what finish() does
    const afterFinish = await survivors();

    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
    await seedAll();
    await invalidateForSessionClose(); // what discard() does
    const afterDiscard = await survivors();

    const extra = afterFinish.filter((k) => !afterDiscard.includes(k));
    const missing = afterDiscard.filter((k) => !afterFinish.includes(k));
    expect(extra).toEqual([cacheKeys.doneWorkouts(PROG)]);
    expect(missing).toEqual([]);
  });

  it("finish PATCHES the done-workout cache rather than dropping it", async () => {
    // dropping is a no-op offline: the refetch that would rebuild it is
    // exactly what cannot run, and the day keeps reading as unfinished
    await cacheSet(cacheKeys.doneWorkouts(PROG), ["pw-other"]);
    await invalidateForSetChange();
    const keys = await cacheKeysWithPrefix(cacheFamilies.sessionClosed);
    expect(keys).toEqual([cacheKeys.doneWorkouts(PROG)]);
    for (const key of keys) {
      const ids = (await cacheGet<string[]>(key)) ?? [];
      await cacheSet(key, [...ids, PW]);
    }
    expect(await cacheGet(cacheKeys.doneWorkouts(PROG))).toEqual([
      "pw-other",
      PW,
    ]);
  });

  it("no prefix in one family is a prefix of a key in another", async () => {
    // e.g. adding "session:" would silently swallow sessionRx/sessionSets
    const families = Object.values(cacheFamilies).flat();
    for (const key of ALL_KEYS) {
      const hits = families.filter((p) => key.startsWith(p));
      expect(hits.length, `${key} matched ${hits.join(", ")}`).toBeLessThan(2);
    }
  });
});

// Signing out ended the Supabase session and nothing else: every cached
// program, session, set, training max and coach note stayed readable in
// IndexedDB for whoever opened the app next. The outbox must survive it —
// those sets exist nowhere else, and the sign-out flow asks about them in its
// own confirmation step. A cache drop must never be what discards them.
describe("cacheClearAll (sign-out)", () => {
  it("drops every cached key", async () => {
    for (const key of ALL_KEYS) await cacheSet(key, { seeded: true });
    const db = await getDb();
    expect((await db.getAllKeys("kv")).length).toBe(ALL_KEYS.length);

    await cacheClearAll();

    expect(await db.getAllKeys("kv")).toEqual([]);
    for (const key of ALL_KEYS) expect(await cacheGet(key)).toBeUndefined();
  });

  it("leaves the outbox alone — it is the only copy of unsynced sets", async () => {
    const db = await getDb();
    await db.add("outbox", {
      op: {
        kind: "insert",
        table: "sets",
        payload: { id: "set-1", session_id: "sess-1" },
      },
      created_at: "2026-08-27T00:00:00.000Z",
      retries: 0,
      last_error: null,
      status: "pending",
    } as never);
    await cacheSet(cacheKeys.plannedWorkouts, { seeded: true });

    await cacheClearAll();

    expect(await db.getAllKeys("kv")).toEqual([]);
    expect((await db.getAll("outbox")).length).toBe(1);
  });
});

// The device cache belongs to exactly ONE person. Signing out is not the only
// way that person changes: a refresh token can expire and someone else can sign
// in with no SIGNED_OUT in between, and that path would have handed one user
// the other's cached plan, sets and training maxes.
describe("claimCacheFor (whose device cache is this)", () => {
  const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
  const BOB = "bbbbbbbb-2222-4222-8222-222222222222";

  // node >=22 defines a global localStorage that is unavailable without a
  // backing file, so stub it the way settings.test.ts does.
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

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears when the user changes, and says that it did", async () => {
    await cacheSet(cacheKeys.plannedWorkouts, { owner: "alice" });
    expect(await claimCacheFor(ALICE)).toBe(true); // unclaimed -> Alice
    await cacheSet(cacheKeys.plannedWorkouts, { owner: "alice" });

    expect(await claimCacheFor(BOB)).toBe(true);
    expect(await cacheGet(cacheKeys.plannedWorkouts)).toBeUndefined();
  });

  it("is a no-op for the same user, so a reload keeps working offline", async () => {
    await claimCacheFor(ALICE);
    await cacheSet(cacheKeys.plannedWorkouts, { owner: "alice" });

    expect(await claimCacheFor(ALICE)).toBe(false);
    expect(await cacheGet(cacheKeys.plannedWorkouts)).toEqual({
      owner: "alice",
    });
  });

  it("clears on sign-out and again on the next sign-in", async () => {
    await claimCacheFor(ALICE);
    await cacheSet(cacheKeys.plannedWorkouts, { owner: "alice" });

    expect(await claimCacheFor(null)).toBe(true); // signed out
    expect(await cacheGet(cacheKeys.plannedWorkouts)).toBeUndefined();
    expect(await claimCacheFor(BOB)).toBe(true); // and Bob starts empty
  });

  it("never touches the outbox — that is unsynced work, not a cache", async () => {
    const db = await getDb();
    await claimCacheFor(ALICE);
    await db.add("outbox", {
      op: {
        kind: "insert",
        table: "sets",
        payload: { id: "s1", session_id: "x" },
      },
      created_at: "2026-08-27T00:00:00.000Z",
      retries: 0,
      last_error: null,
      status: "pending",
      user_id: ALICE,
    } as never);

    await claimCacheFor(BOB);

    const held = await db.getAll("outbox");
    expect(held.length).toBe(1);
    expect(held[0].user_id).toBe(ALICE);
  });
});
