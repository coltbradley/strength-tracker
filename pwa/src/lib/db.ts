// IndexedDB layer (idb wrapper). Two stores:
//  - outbox: ordered write queue (auto-increment key preserves enqueue order)
//  - kv: read cache (exercise list, prescriptions, last actuals, active session)

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SessionEndPatch, SessionInsert, SetInsert } from "./types";

export type OutboxOp =
  | { kind: "insert"; table: "sessions"; payload: SessionInsert }
  | { kind: "insert"; table: "sets"; payload: SetInsert }
  | { kind: "update"; table: "sessions"; id: string; patch: SessionEndPatch };

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

export const cacheKeys = {
  programs: "programs",
  plannedWorkouts: "plannedWorkouts",
  exercises: "exercises",
  activeSession: "activeSession",
  lastActuals: (excludeSessionId?: string) =>
    `lastActuals:${excludeSessionId ?? "all"}`,
  prescriptions: (plannedWorkoutId: string) => `rx:${plannedWorkoutId}`,
  sessionRx: (sessionId: string) => `sessionRx:${sessionId}`,
  sessionExtras: (sessionId: string) => `sessionExtras:${sessionId}`,
  sessionSets: (sessionId: string) => `sessionSets:${sessionId}`,
  doneWorkouts: (programId: string) => `doneWorkouts:${programId}`,
  e1rm: (exerciseId: string) => `e1rm:${exerciseId}`,
  volume: (exerciseId: string) => `volume:${exerciseId}`,
  goal: (exerciseId: string) => `goal:${exerciseId}`,
  recentSets: (exerciseId: string) => `recent:${exerciseId}`,
};
