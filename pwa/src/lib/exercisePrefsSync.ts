// Cross-device sync for the per-exercise preference record (`ExercisePref` in
// settings.ts) through the `exercise_prefs` table (20261001000000).
//
// WHAT SYNCS: only the per-exercise record — base weight (`barKg`, a bar or a
// machine's sled), plates vs stack (`loadStyle`), one vs two dumbbells
// (`loadEntry`), rest, coarse step and authored unit. Global device settings
// (plate and bar inventories, display unit, steps, rest defaults) stay
// device-local. All of it is PRESENTATION: nothing here ever changes `load_kg`.
//
// WRITE: a local change (settings.ts stamps it and tells us) is queued through
// the outbox as a merging upsert on (user_id, exercise_id), stamped with its
// owner like every other queued write and carrying the client-stamped
// `updated_at`. Replay is idempotent: Postgres's `exercise_prefs_lww` trigger
// keeps whichever write is newer, so a replay — or a phone that was offline
// for a week — cannot clobber a newer choice. Clearing writes a TOMBSTONE (all
// values null), never a delete; there is no delete policy (see the migration).
//
// READ: on start, on every identity change and (at most every few minutes) on
// return to the foreground, the user's rows are fetched and merged
// last-write-wins by `updated_at` against this device's stamps. Local entries
// that are newer, or that the server has never seen, are uploaded in the same
// pass, which is also how writes made while identity was unknown get sent.
//
// IDENTITY: the prefs carry an owner. A different account signing in clears
// them BEFORE anything is uploaded, so one person's preferences never become
// another's; nothing is ever queued while identity is unknown or while the
// prefs belong to someone else, and the outbox HOLDS any item whose owner is
// not the live identity, exactly as for sets.
//
// The factory takes its I/O as dependencies so the rules are testable without
// a network; lib/exercisePrefsSyncApp.ts wires the real ones.

import type { OutboxOp } from "./db";
import {
  getExercisePrefsSyncState,
  getSetting,
  replaceExercisePrefsState,
  subscribeExercisePrefWrites,
  type ExercisePref,
  type ExercisePrefs,
} from "./settings";
import type { ExercisePrefRow, ExercisePrefUpsert } from "./types";

// ---- pure ------------------------------------------------------------------

/** A server row as a device record; null for a tombstone. Values are not
 *  re-validated here: `replaceExercisePrefsState` runs them through the same
 *  parser every stored setting goes through. */
export function rowToPref(row: ExercisePrefRow): ExercisePref | null {
  const pref: ExercisePref = {};
  if (row.bar_kg !== null) pref.barKg = row.bar_kg;
  if (row.rest_seconds !== null) pref.restSeconds = row.rest_seconds;
  if (row.load_step_kg !== null) pref.loadStepKg = row.load_step_kg;
  if (row.load_unit !== null) pref.loadUnit = row.load_unit;
  if (row.load_entry !== null) pref.loadEntry = row.load_entry;
  if (row.load_style !== null) pref.loadStyle = row.load_style;
  return Object.keys(pref).length === 0 ? null : pref;
}

/** The queued upsert for one exercise. EVERY column is written on every row
 *  (null included): a merge that omitted a cleared field would leave the old
 *  value standing on the server. */
export function prefToUpsert(
  userId: string,
  exerciseId: string,
  pref: ExercisePref | null,
  updatedAt: string,
): ExercisePrefUpsert {
  return {
    user_id: userId,
    exercise_id: exerciseId,
    bar_kg: pref?.barKg ?? null,
    rest_seconds: pref?.restSeconds ?? null,
    load_step_kg: pref?.loadStepKg ?? null,
    load_unit: pref?.loadUnit ?? null,
    load_entry: pref?.loadEntry ?? null,
    load_style: pref?.loadStyle ?? null,
    updated_at: updatedAt,
  };
}

export function prefOp(payload: ExercisePrefUpsert): OutboxOp {
  return { kind: "insert", table: "exercise_prefs", payload };
}

export interface PrefUpload {
  exerciseId: string;
  pref: ExercisePref | null;
  updatedAt: string;
}

export interface MergeResult {
  prefs: ExercisePrefs;
  stamps: Record<string, string>;
  /** local state the server is behind on */
  uploads: PrefUpload[];
}

function ms(iso: string | undefined): number {
  return iso === undefined ? NaN : Date.parse(iso);
}

/**
 * Last-write-wins, per exercise, by `updated_at`:
 *  - server newer than this device's stamp (or no stamp at all): take the
 *    server's value, tombstones included, and adopt its stamp;
 *  - device stamp newer: keep ours and upload it;
 *  - equal: nothing to do;
 *  - device has a pref the server has never seen: upload it, stamping it now
 *    if it predates sync. A device tombstone the server never saw needs
 *    nothing.
 * An unstamped device pref loses to any server row: it predates sync, so the
 * server's answer is the newer one.
 */
export function mergeExercisePrefs(
  local: ExercisePrefs,
  stamps: Record<string, string>,
  remote: readonly ExercisePrefRow[],
  nowIso: string,
): MergeResult {
  const prefs: ExercisePrefs = { ...local };
  const st: Record<string, string> = { ...stamps };
  const uploads: PrefUpload[] = [];
  const seen = new Set<string>();

  for (const row of remote) {
    const rMs = ms(row.updated_at);
    if (!Number.isFinite(rMs)) continue;
    const id = row.exercise_id;
    seen.add(id);
    const lMs = ms(st[id]);
    if (!Number.isFinite(lMs) || rMs > lMs) {
      const pref = rowToPref(row);
      if (pref === null) delete prefs[id];
      else prefs[id] = pref;
      st[id] = row.updated_at;
    } else if (lMs > rMs) {
      uploads.push({ exerciseId: id, pref: prefs[id] ?? null, updatedAt: st[id] });
    }
  }

  for (const [id, pref] of Object.entries(prefs)) {
    if (seen.has(id)) continue;
    let stamp = st[id];
    if (!Number.isFinite(ms(stamp))) {
      stamp = nowIso;
      st[id] = stamp;
    }
    uploads.push({ exerciseId: id, pref, updatedAt: stamp });
  }

  return { prefs, stamps: st, uploads };
}

// ---- the sync loop -----------------------------------------------------------

export interface ExercisePrefsSyncDeps {
  /** The signed-in user's rows, FRESH from the server. Throws when the server
   *  could not be read; there is deliberately no cached fallback (see
   *  `reconcile`). */
  fetchRows: () => Promise<ExercisePrefRow[]>;
  /** Queue writes through the outbox (which stamps the owner on the item). */
  enqueue: (ops: readonly OutboxOp[]) => Promise<void>;
  /** `exercise_id@updated_at` of every queued, not-dead exercise_prefs write,
   *  so a reconcile does not queue a second copy of one already waiting. */
  pendingKeys: () => Promise<Set<string>>;
  /** Live identity; null = signed out OR not known yet. */
  currentUserId: () => string | null;
  onUserChange?: (fn: (id: string | null) => void) => () => void;
  /** Report a failed read or write. The caller decides what is worth a toast
   *  (an offline read is not). */
  report: (e: unknown, context: string) => void;
  now?: () => number;
  /** Minimum gap between foreground-triggered reconciles. */
  foregroundIntervalMs?: number;
}

export interface ExercisePrefsSync {
  /** Pull, merge, and push what the server is behind on. Serialized. */
  reconcile(): Promise<void>;
  /** Wire the write listener and the triggers. Idempotent. */
  start(): void;
  /** Undo `start` (tests). */
  stop(): void;
}

export function pendingKey(exerciseId: string, updatedAt: string): string {
  return `${exerciseId}@${updatedAt}`;
}

export function createExercisePrefsSync(
  deps: ExercisePrefsSyncDeps,
): ExercisePrefsSync {
  const now = deps.now ?? (() => Date.now());
  const interval = deps.foregroundIntervalMs ?? 5 * 60_000;
  let chain: Promise<void> = Promise.resolve();
  let lastRun = -Infinity;
  let started = false;
  const unsubs: Array<() => void> = [];

  /**
   * Make the device prefs belong to `uid`. A different previous owner means
   * these are someone else's: they are dropped, never uploaded. Unowned prefs
   * (from before sync existed) are adopted by the first account seen.
   */
  function claimFor(uid: string): void {
    const sync = getExercisePrefsSyncState();
    if (sync.owner === uid) return;
    if (sync.owner === null) {
      replaceExercisePrefsState(getSetting("exercisePrefs"), {
        owner: uid,
        stamps: sync.stamps,
      });
      return;
    }
    replaceExercisePrefsState({}, { owner: uid, stamps: {} });
  }

  async function doReconcile(): Promise<void> {
    const uid = deps.currentUserId();
    if (uid === null) return; // unknown is not permission; identity re-runs us
    claimFor(uid);
    lastRun = now();

    // FRESH rows only. The device copy already lives in the settings envelope,
    // so a cached server read could only ever be older than what we hold — or,
    // in the window before the kv cache's owner check has run, another
    // account's rows, whose prefs we would then adopt and later upload as
    // this account's. Offline, the merge simply waits for the next trigger.
    let rows: ExercisePrefRow[];
    try {
      rows = await deps.fetchRows();
    } catch (e) {
      deps.report(e, "load exercise settings");
      return;
    }

    // Identity may have changed while we were waiting on the network: these
    // rows are then not the signed-in person's, and must not be merged.
    if (deps.currentUserId() !== uid) return;
    if (getExercisePrefsSyncState().owner !== uid) return;

    const sync = getExercisePrefsSyncState();
    const merged = mergeExercisePrefs(
      getSetting("exercisePrefs"),
      sync.stamps,
      rows,
      new Date(now()).toISOString(),
    );
    replaceExercisePrefsState(merged.prefs, { owner: uid, stamps: merged.stamps });

    if (merged.uploads.length === 0) return;
    let pending: Set<string>;
    try {
      pending = await deps.pendingKeys();
    } catch {
      pending = new Set();
    }
    const ops = merged.uploads
      .filter((u) => !pending.has(pendingKey(u.exerciseId, u.updatedAt)))
      .map((u) => prefOp(prefToUpsert(uid, u.exerciseId, u.pref, u.updatedAt)));
    if (ops.length === 0) return;
    if (deps.currentUserId() !== uid) return;
    try {
      await deps.enqueue(ops);
    } catch (e) {
      deps.report(e, "queue exercise settings");
    }
  }

  function reconcile(): Promise<void> {
    chain = chain.then(doReconcile, doReconcile);
    return chain;
  }

  /** A choice made on this device: queue it, if and only if it is provably
   *  the signed-in person's. Otherwise the next reconcile carries it (after
   *  an identity arrives) or drops it (if the prefs change hands). */
  function onLocalWrite(
    exerciseId: string,
    pref: ExercisePref | null,
    updatedAt: string,
  ): void {
    const uid = deps.currentUserId();
    if (uid === null) return;
    if (getExercisePrefsSyncState().owner !== uid) return;
    deps
      .enqueue([prefOp(prefToUpsert(uid, exerciseId, pref, updatedAt))])
      .catch((e: unknown) => deps.report(e, "queue exercise setting"));
  }

  return {
    reconcile,
    start() {
      if (started) return;
      started = true;
      unsubs.push(subscribeExercisePrefWrites(onLocalWrite));
      const offUser = deps.onUserChange?.((id) => {
        if (id !== null) void reconcile();
      });
      if (offUser) unsubs.push(offUser);
      if (typeof document !== "undefined") {
        const onVisible = (): void => {
          if (document.visibilityState !== "visible") return;
          if (now() - lastRun < interval) return;
          void reconcile();
        };
        document.addEventListener("visibilitychange", onVisible);
        unsubs.push(() =>
          document.removeEventListener("visibilitychange", onVisible),
        );
      }
      void reconcile();
    },
    stop() {
      for (const off of unsubs.splice(0)) off();
      started = false;
    },
  };
}
