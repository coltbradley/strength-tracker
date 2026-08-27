// IndexedDB layer (idb wrapper). Two stores:
//  - outbox: ordered write queue (auto-increment key preserves enqueue order)
//  - kv: read cache (exercise list, prescriptions, last actuals, active session)

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  SessionInsert,
  SessionPatch,
  SetInsert,
  SetNoteUpsert,
  SetVoidInsert,
} from "./types";

export type OutboxOp =
  | { kind: "insert"; table: "sessions"; payload: SessionInsert }
  | { kind: "insert"; table: "sets"; payload: SetInsert }
  | { kind: "insert"; table: "set_voids"; payload: SetVoidInsert }
  // set_notes is the one MERGING insert: replaying overwrites (a note edit
  // is last-write-wins), unlike the do-nothing semantics everywhere else
  | { kind: "insert"; table: "set_notes"; payload: SetNoteUpsert }
  | { kind: "update"; table: "sessions"; id: string; patch: SessionPatch };

export interface OutboxItem {
  op: OutboxOp;
  created_at: string;
  retries: number;
  last_error: string | null;
  /** 'dead' = permanently failing, skipped by flush until retryDead() */
  status: "pending" | "dead";
}

interface StrengthDB extends DBSchema {
  outbox: { key: number; value: OutboxItem };
  kv: { key: string; value: unknown };
}

export type Database = IDBPDatabase<StrengthDB>;

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  // DATA SAFETY: this database holds unsynced training data (the outbox).
  // App updates must never lose it. If you bump the version, the upgrade
  // callback must be strictly additive (create new stores/indexes, migrate
  // rows forward); never delete the "outbox" or "kv" stores, and never
  // rename the database. Guard old-version branches with
  // `if (oldVersion < N)` so existing data flows through untouched.
  dbPromise ??= openDB<StrengthDB>("strength-log", 1, {
    upgrade(db) {
      db.createObjectStore("outbox", { autoIncrement: true });
      db.createObjectStore("kv");
    },
  });
  return dbPromise;
}

/** Test hook: reset the cached connection so fake-indexeddb starts clean. */
export function resetDbForTests(): void {
  dbPromise = null;
}

// ---- kv cache helpers ------------------------------------------------------

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get("kv", key)) as T | undefined;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put("kv", value, key);
}

export async function cacheDelete(key: string): Promise<void> {
  const db = await getDb();
  await db.delete("kv", key);
}

/** Drop every cache entry whose key starts with one of the prefixes.
 *  Used when a write invalidates a whole family (e.g. discarding a session
 *  touches every exercise's history caches). */
export async function cacheDeleteByPrefix(
  prefixes: readonly string[],
): Promise<void> {
  const db = await getDb();
  const keys = await db.getAllKeys("kv");
  for (const key of keys) {
    if (typeof key === "string" && prefixes.some((p) => key.startsWith(p))) {
      await db.delete("kv", key);
    }
  }
}

/** Every stored kv key under one of the prefixes. Lets a caller PATCH a
 *  cache family instead of dropping it — dropping is wrong offline, where
 *  the refetch that would rebuild it cannot run. */
export async function cacheKeysWithPrefix(
  prefixes: readonly string[],
): Promise<string[]> {
  const db = await getDb();
  const keys = await db.getAllKeys("kv");
  return keys.filter(
    (k): k is string =>
      typeof k === "string" && prefixes.some((p) => k.startsWith(p)),
  );
}

/**
 * THE prefix vocabulary. Every key builder below composes one of these, and
 * every invalidation family is declared from the same constants — so a
 * prefix is written exactly once and "which family does this key belong to"
 * is answered here rather than remembered at each call site. Three screens
 * used to carry hand-copied literal lists, and the one asymmetry between
 * them (finish vs discard) was a real bug.
 */
const P = {
  lastActuals: "lastActuals:",
  loggedExercises: "loggedExercises",
  prescriptions: "rx:",
  sessionRx: "sessionRx:",
  trainingMaxes: "trainingMaxes",
  doneWorkouts: "doneWorkouts:",
  e1rm: "e1rm:",
  volume: "volume:",
  goal: "goal:",
  recentSets: "recent:",
  sessionMeta: "sessionMeta:",
  setNotes: "setNotes:",
  adherence: "adherence:",
} as const;

export const cacheKeys = {
  plannedWorkouts: "plannedWorkouts",
  exercises: "exercises",
  activeSession: "activeSession",
  lastActuals: (excludeSessionId?: string) =>
    `${P.lastActuals}${excludeSessionId ?? "all"}`,
  /** exercise ids with at least one live logged set (History's index) */
  loggedExercises: P.loggedExercises,
  prescriptions: (plannedWorkoutId: string) =>
    `${P.prescriptions}${plannedWorkoutId}`,
  sessionRx: (sessionId: string) => `${P.sessionRx}${sessionId}`,
  sessionExtras: (sessionId: string) => `sessionExtras:${sessionId}`,
  sessionSets: (sessionId: string) => `sessionSets:${sessionId}`,
  /** set ids voided this session (filters merges of server+pending sets) */
  sessionVoids: (sessionId: string) => `sessionVoids:${sessionId}`,
  /** entry keys the user marked skipped in this session */
  sessionSkips: (sessionId: string) => `sessionSkips:${sessionId}`,
  /** live rest-timer state, so Home round-trips / reloads don't lose it */
  sessionRest: (sessionId: string) => `sessionRest:${sessionId}`,
  /** per-set notes for the in-flight session, set_id -> note */
  sessionSetNotes: (sessionId: string) => `sessionSetNotes:${sessionId}`,
  /** staged End-screen input (sRPE / bodyweight / note), so a trip back to
   *  the session and forward again does not lose what was typed */
  sessionEndDraft: (sessionId: string) => `sessionEndDraft:${sessionId}`,
  doneWorkouts: (programId: string) => `${P.doneWorkouts}${programId}`,
  e1rm: (exerciseId: string) => `${P.e1rm}${exerciseId}`,
  volume: (exerciseId: string) => `${P.volume}${exerciseId}`,
  goal: (exerciseId: string) => `${P.goal}${exerciseId}`,
  recentSets: (exerciseId: string) => `${P.recentSets}${exerciseId}`,
  /** notes/sRPE/bodyweight for the sessions behind one exercise's history */
  sessionMeta: (exerciseId: string) => `${P.sessionMeta}${exerciseId}`,
  /** per-set notes for one exercise's history */
  setNotes: (exerciseId: string) => `${P.setNotes}${exerciseId}`,
  /** prescribed-vs-achieved for one exercise's history */
  adherence: (exerciseId: string) => `${P.adherence}${exerciseId}`,
  /** every training max ever set */
  trainingMaxes: P.trainingMaxes,
};

/**
 * Invalidation families. `data.ts` exposes the verbs (`invalidateForSetChange`
 * / `invalidateForSessionClose`); nothing outside it should name a prefix.
 *
 * Adding a key to `cacheKeys` means deciding which family it joins — and
 * `db.test.ts` fails if it joins none, because it pins the exact survivors.
 */
export const cacheFamilies = {
  /** derived from a session's SETS: changes whenever a set is logged,
   *  voided, or leaves via a discard */
  sessionDerived: [
    P.recentSets,
    P.e1rm,
    P.volume,
    P.goal,
    P.sessionMeta,
    P.setNotes,
    P.adherence,
    P.lastActuals,
    P.loggedExercises,
  ],
  /** derived from whether a session is CLOSED: the week's DONE state */
  sessionClosed: [P.doneWorkouts],
  /** carries a resolved training max, so any TM write invalidates it */
  planResolved: [P.prescriptions, P.sessionRx],
} as const;
