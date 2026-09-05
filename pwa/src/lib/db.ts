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
  /**
   * Who queued this. Payloads leave `user_id` to the database default
   * (auth.uid()), which was safe while one person could ever be signed in and
   * became a data-integrity hazard the moment two could: a set queued offline
   * by one user and flushed after a different user signed in would be stamped,
   * permanently and append-only, with the wrong owner.
   *
   * Optional because items queued before multi-user have no owner recorded.
   * Those are treated as belonging to whoever is signed in, which is exactly
   * what they already were.
   */
  user_id?: string;
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

/**
 * Drop the ENTIRE server-data cache. The one caller is sign-out.
 *
 * `kv` mirrors this user's programs, sessions, sets, training maxes and coach
 * notes so the app works offline. Signing out cleared the Supabase session and
 * nothing else, so all of it stayed readable on the device — indefinitely, and
 * to whoever signs in next. That is the first thing that has to be true before
 * a second person ever opens this app in the same browser.
 *
 * `outbox` is deliberately NOT touched. It holds sets that exist nowhere else;
 * the sign-out flow already makes the user discard those explicitly, in their
 * own confirmation step, and a cache drop must never be the thing that does it.
 */
export async function cacheClearAll(): Promise<void> {
  const db = await getDb();
  await db.clear("kv");
  for (const key of LOCAL_CACHE_KEYS) {
    try {
      storage()?.removeItem(key);
    } catch {
      // storage blocked; the kv half is cleared, which is the data that matters
    }
  }
}

/**
 * Cached user data that lives in localStorage rather than in `kv`, and must be
 * dropped on the same boundary.
 *
 * The coach thread is the whole list. It sat outside every clearing path, so
 * signing out and handing the phone over left the previous person's questions
 * and the coach's answers about their training verbatim on screen for the next
 * one. It is in localStorage rather than `kv` because it is written on every
 * streamed token and reads have to be synchronous; that is a fine reason to
 * store it there and no reason at all to exempt it from ownership.
 */
const LOCAL_CACHE_KEYS = ["strength-log.coach.thread"] as const;

/** The coach thread's storage key. Defined here, beside the clearing path
 *  that has to know about it, so the two can never drift apart. */
export const COACH_THREAD_KEY = LOCAL_CACHE_KEYS[0];

/**
 * Which user the `kv` cache belongs to. Kept in localStorage rather than in
 * `kv` itself, because `kv` is the thing being cleared.
 *
 * Cache keys are NOT namespaced by user, deliberately: the registry below is
 * the single vocabulary for every key in the app, and threading a user id
 * through it would mean every call site could get the prefix wrong. One marker
 * plus "clear when it changes" has one place to be wrong instead of forty.
 */
const CACHE_OWNER_KEY = "strengthLogCacheOwner";

/** Same access pattern as settings.ts: the bare global, guarded. `window` is
 *  not it — node defines localStorage without a window, and the tests run on
 *  the node environment. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked: treat the cache as unowned, which clears
  }
}

function readCacheOwner(): string | null {
  return storage()?.getItem(CACHE_OWNER_KEY) ?? null;
}

/**
 * Make the device cache belong to `userId`, clearing it if it belonged to
 * anyone else. Returns true when it cleared.
 *
 * Signing out is not the only way the person at the device changes: a refresh
 * token can expire and someone else can sign in, with no SIGNED_OUT in between.
 * That path would have shown one user the other's cached plan, sets and
 * training maxes. The outbox is never touched here — it holds unsynced work,
 * and the flusher already refuses to replay one user's writes as another.
 */
export async function claimCacheFor(userId: string | null): Promise<boolean> {
  // With nowhere to record the owner we cannot detect a change, and treating
  // "unknown" as "someone else" would clear the cache on EVERY load — which
  // would quietly destroy the offline promise for anyone in private mode. Do
  // nothing instead: in those contexts IndexedDB is usually per-session anyway,
  // so the data does not outlive the visit that created it.
  if (storage() === null) return false;

  const previous = readCacheOwner();
  if (previous === userId) return false;

  await cacheClearAll();
  try {
    if (userId === null) storage()?.removeItem(CACHE_OWNER_KEY);
    else storage()?.setItem(CACHE_OWNER_KEY, userId);
  } catch {
    // storage blocked: the cache is cleared, which is the safe half
  }
  return true;
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
  /** mid-session exercise substitutions, entry key -> the movement actually
   *  performed. Session-scoped and device-local like extras and skips, and in
   *  no invalidation family for the same reason they are in none: it is a
   *  fact about today's performance, not a projection of anything on the
   *  server, so nothing a set or a session close does can stale it. */
  sessionSwaps: (sessionId: string) => `sessionSwaps:${sessionId}`,
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
