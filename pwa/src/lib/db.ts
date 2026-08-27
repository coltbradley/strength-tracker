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
export async function cacheDeleteByPrefix(prefixes: string[]): Promise<void> {
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
  prefixes: string[],
): Promise<string[]> {
  const db = await getDb();
  const keys = await db.getAllKeys("kv");
  return keys.filter(
    (k): k is string =>
      typeof k === "string" && prefixes.some((p) => k.startsWith(p)),
  );
}

export const cacheKeys = {
  plannedWorkouts: "plannedWorkouts",
  exercises: "exercises",
  activeSession: "activeSession",
  lastActuals: (excludeSessionId?: string) =>
    `lastActuals:${excludeSessionId ?? "all"}`,
  prescriptions: (plannedWorkoutId: string) => `rx:${plannedWorkoutId}`,
  sessionRx: (sessionId: string) => `sessionRx:${sessionId}`,
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
  doneWorkouts: (programId: string) => `doneWorkouts:${programId}`,
  e1rm: (exerciseId: string) => `e1rm:${exerciseId}`,
  volume: (exerciseId: string) => `volume:${exerciseId}`,
  goal: (exerciseId: string) => `goal:${exerciseId}`,
  recentSets: (exerciseId: string) => `recent:${exerciseId}`,
};
