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
import { beforeEach, describe, expect, it } from "vitest";
import {
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
  cacheKeys.sessionVoids(SESS),
  cacheKeys.trainingMaxes,
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
