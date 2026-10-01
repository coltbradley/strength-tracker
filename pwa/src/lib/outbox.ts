// Offline write queue. EVERY write goes here first; a flusher replays the
// queue to Supabase strictly in enqueue order. Inserts use upsert with
// ignoreDuplicates (on conflict do nothing) + client-generated UUIDs, so
// replay after a partial failure is idempotent. Session end is a plain
// update, idempotent by nature. A write is NEVER silently dropped.
//
// Error classification (so one bad item can't block the queue forever):
//  - network / 5xx / timeout            -> keep 'pending', retry later, flush stops
//  - 23503 FK on a sets insert with a prescription_id -> the prescription was
//    deleted server-side; null the prescription_id and retry once (the set
//    data must survive)
//  - 401 -> attempt ONE auth refresh per flush, retry; still failing -> 'dead'
//  - other constraint/RLS/client errors (23xxx, 42501, 400/403/404/409/422)
//    -> mark 'dead': kept in IndexedDB with last_error AND the code and status
//    that caused it, skipped by the flusher, listed in <OutboxSheet> where it
//    can be retried or exported
// The flusher keeps going past dead items.
//
// Dead is not the same as hopeless, and the difference is `deadKind` below:
// a retry is only offered for the failures whose answer can still change.
//
// The outbox knows nothing about screens; screens know nothing about sync.

import { cacheKeys, type Database, type OutboxItem, type OutboxOp } from "./db";
import type { SetInsert } from "./types";

export type SyncState = "idle" | "syncing" | "error";

export interface OutboxStatus {
  pending: number;
  dead: number;
  /**
   * How many of `pending` this device must not send: queued by another
   * account, or queued before identity resolved. A SUBSET of `pending`, not a
   * third bucket — the item is queued and healthy, this device is simply not
   * the one to send it, and making it a separate total would have changed
   * what every existing reader of `pending` means.
   */
  held: number;
  state: SyncState;
  lastError: string | null;
}

export interface TransportError {
  message: string;
  /** Postgres/PostgREST error code, e.g. '23503', '42501', 'PGRST301' */
  code: string | null;
  /** HTTP status of the response, when one was received */
  status: number | null;
}

/** The Supabase calls the outbox needs, abstracted for tests. */
export interface OutboxTransport {
  /** upsert on the table's pk ('set_id' for set_voids/set_notes, 'id'
   *  elsewhere); null on success. set_notes MERGES on conflict (note edits
   *  are last-write-wins); every other table ignores duplicates. */
  insert(
    table:
      | "sessions"
      | "sets"
      | "set_voids"
      | "set_notes"
      | "bodyweight_log"
      | "daily_readiness"
      | "checkins"
      | "symptom_episodes"
      | "pain_checks"
      | "report_prompts"
      | "feedback"
      | "session_skips",
    payload: unknown,
  ): Promise<TransportError | null>;
  update(
    table: "sessions" | "symptom_episodes",
    id: string,
    patch: unknown,
  ): Promise<TransportError | null>;
  /** try to refresh the auth session; true if a valid session exists after */
  refreshAuth?(): Promise<boolean>;
}

export interface Outbox {
  enqueue(op: OutboxOp): Promise<void>;
  enqueueBatch(ops: readonly OutboxOp[]): Promise<void>;
  /** Atomically queue replacement then original void and persist their link. */
  enqueueCorrection(sessionId: string, replacement: SetInsert, originalId: string): Promise<void>;
  flush(): Promise<void>;
  /**
   * Re-queue the dead items a retry could actually help, and flush. Items
   * the server refused on the merits of the row itself are left where they
   * are — see `deadKind`. Returns what it did, so the caller can say so
   * instead of implying a rescue that never happened.
   */
  retryDead(): Promise<RetryOutcome>;
  /** After a queue export and explicit review, keep the logged kg total and
   *  retry one rejected set with its inconsistent authored provenance unknown. */
  repairDeadLoadSet(key: number, expected: SetInsert): Promise<boolean>;
  /** Atomically repair every eligible set in one reviewed queue export. A
   *  stale or incomplete snapshot changes nothing. Child writes stay dead. */
  repairDeadLoadSets(expected: readonly OutboxEntry[]): Promise<boolean>;
  /**
   * Every queued item, in replay order, for the pending-writes view. The one
   * READ of the queue as a queue: everything else here asks it a question
   * about one session or one set.
   */
  inspect(): Promise<OutboxEntry[]>;
  getStatus(): OutboxStatus;
  subscribe(fn: () => void): () => void;
  /** Exact server ACKs with the owner captured immediately before transport. */
  subscribeSynced(fn: (op: OutboxOp, ownerId: string | null | undefined) => void): () => void;
  /** Queued (unsynced) set inserts for a session — dead ones included, the
   *  user logged them and the UI must reflect them. */
  pendingSets(sessionId: string): Promise<SetInsert[]>;
  /** Session ids with a queued (unsynced) sessions update — e.g. an ended_at
   *  or discarded_at patch that hasn't reached the server yet. */
  pendingSessionUpdateIds(): Promise<Set<string>>;
  /**
   * Set ids with a queued (unsynced) void. The user removed the set; the
   * server may not know yet, so a read of `v_live_sets` still returns it and
   * would put it back on screen. Screens that render server rows subtract
   * this set to stay honest offline.
   *
   * Dead ones are included, like `pendingSets` and `pendingSessionUpdateIds`:
   * a void that failed to replay has still been ASKED for, and resurrecting
   * the row is the one answer the user already rejected. It stays hidden
   * until retryDead() lands it or the item is dealt with in SyncStatus.
   */
  pendingVoidIds(): Promise<Set<string>>;
  /**
   * Session ids with a queued (unsynced) DISCARD specifically — a strict
   * subset of pendingSessionUpdateIds. The two are not interchangeable and
   * the difference is not cosmetic: an ended_at patch queued offline means
   * the session finished and its sets must keep showing in history, while a
   * discarded_at patch means the whole day should be gone. Filtering history
   * on "has any pending sessions update" would make a session vanish from
   * history for the sole crime of having been finished offline.
   */
  pendingDiscardIds(): Promise<Set<string>>;
  /**
   * Session ids with a queued (unsynced) sRPE rating — the other strict
   * subset of pendingSessionUpdateIds, and needed for the same reason
   * `pendingVoidIds` is. Today asks "which finished session has no rating"
   * of the SERVER, which has not heard about a rating given in a basement
   * gym, so without this the prompt comes straight back on the next render
   * and asks again for a number already given. Dead ones count too: it has
   * been ANSWERED, and re-asking is the one thing that must not happen.
   */
  pendingRatedSessionIds(): Promise<Set<string>>;
  /** Owner-bound correction joins from pending voids and acknowledged witnesses. */
  correctionLinks(sessionId: string): Promise<Record<string, string>>;
  /** Wire up app-start + 'online' triggers. */
  start(): void;
}

interface Deps {
  getDb: () => Promise<Database>;
  transport: OutboxTransport;
  isOnline?: () => boolean;
  /**
   * The signed-in user, or null when nobody is — AND null while the answer is
   * still unknown, which is the state the app boots in. Used to stamp queued
   * items with their owner and to refuse to replay one person's writes as
   * another. Omitted in tests that do not exercise identity.
   */
  currentUserId?: () => string | null;
  /**
   * Whose write this is at ENQUEUE time, when that can be known better than
   * `currentUserId`: the app boots with its UI drawn from the session saved on
   * the device while the live identity is still a network refresh away, and a
   * set logged in that window belongs to that saved account. Identity only,
   * never authorization: replay still waits for `currentUserId` to match.
   * Defaults to `currentUserId`.
   */
  stampUserId?: () => string | null;
  /**
   * Subscribe to identity changes; returns an unsubscribe. Because an unknown
   * identity now HOLDS stamped items (see `replayable`), something has to run
   * the queue again once identity arrives, or a queue that was held at boot
   * would sit there until the next `online` event or the next write.
   */
  onIdentityChange?: (fn: (id: string | null) => void) => () => void;
  /**
   * Told about an op right after it actually reaches the server — not when
   * it is enqueued, and not for one that stays pending, held or dead. This
   * is the hook a caller uses to react to a write being CONFIRMED rather than
   * merely queued: the checkin-memory extraction route is fire-and-forget
   * and must ask about a check-in only once the server has it, offline or
   * not. Best-effort: a throwing listener is caught and never turns a
   * successful sync into a failed one.
   */
  onSynced?: (op: OutboxOp) => void;
  /**
   * Delays before retrying after a RETRYABLE failure while online, one per
   * consecutive failure, the last repeating. Without it a timeout on gym wifi
   * left the queue stuck until the next write, an `online` event or a return
   * to the foreground, none of which happens while someone rests between
   * sets with the app open (A-143).
   */
  retryDelaysMs?: readonly number[];
}

type ErrorClass = "retry" | "dead" | "auth" | "fk-prescription";

function classify(op: OutboxOp, err: TransportError): ErrorClass {
  if (
    err.code === "23503" &&
    op.kind === "insert" &&
    op.table === "sets" &&
    op.payload.prescription_id !== null &&
    // only the PRESCRIPTION FK justifies stripping the link — a 23503 on
    // session_id (session insert died earlier) must not destroy it
    /prescription/i.test(err.message)
  ) {
    return "fk-prescription";
  }
  if (err.status === 401) return "auth";
  // An update that matched no row (the transport asks for it back with
  // .single(), and PostgREST answers zero rows with 406 PGRST116). Nothing
  // changed on the server, so it must not leave the queue as synced (A-91),
  // and it must not block the writes behind it either: dead, and retryable
  // through deadKind below.
  if (err.code === "PGRST116") return "dead";
  if (err.code !== null && (/^23\d{3}$/.test(err.code) || err.code === "42501"))
    return "dead";
  if (err.status !== null && [400, 403, 404, 409, 422].includes(err.status))
    return "dead";
  return "retry"; // network errors, 5xx, timeouts, anything unknown
}

/**
 * Why the server refused a DEAD item, and therefore whether asking again
 * could ever produce a different answer. `classify` above decides what to do
 * in the moment; this decides what a retry button is allowed to promise, and
 * it reads the recorded CODE and STATUS, never the message — the prose is
 * whatever PostgREST felt like saying that day.
 *
 *  - 'auth'     the refresh answered "no session". A later sign-in changes it.
 *  - 'blocked'  refused by state OUTSIDE the payload. 42501/403 is a row-level
 *               policy judging the CALLER, and a 23503 past the prescription
 *               special case is an ancestor row that never landed — the
 *               session insert sitting AHEAD of this one in the queue. Both
 *               change when the queue is replayed by the right person in
 *               order, which is exactly what retryDead does.
 *  - 'rejected' a judgement on the ROW: not-null, check, unique, or a request
 *               the server could not parse. Same bytes, same answer, forever.
 *               These are the ones a retry button must not offer to fix.
 *  - 'unknown'  no evidence. Items that died before the code was recorded, and
 *               a 404, which is about the ENDPOINT rather than the row and can
 *               come back. Treated as retryable: refusing to try on no
 *               evidence is the worse of the two guesses.
 */
export type DeadKind = "auth" | "blocked" | "rejected" | "unknown";

export function deadKind(
  code: string | null | undefined,
  status: number | null | undefined,
): DeadKind {
  if (status === 401) return "auth";
  // PGRST116 is an update that found no row to change: usually the session
  // insert that should precede it has not landed, or the row is not visible
  // to this caller. Both are state outside the payload, like 23503 (A-91).
  if (
    code === "42501" ||
    code === "23503" ||
    code === "PGRST116" ||
    status === 403
  )
    return "blocked";
  // codes before statuses, so a 409 carrying 23503 stays 'blocked' and a bare
  // 409 (a conflict on the row) does not
  if (code != null && /^23\d{3}$/.test(code)) return "rejected";
  if (status === 400 || status === 409 || status === 422) return "rejected";
  return "unknown";
}

/** Whether re-queueing this dead item could produce a different answer. */
export function isRetryable(item: OutboxItem): boolean {
  return deadKind(item.last_code, item.last_status) !== "rejected";
}

const LOAD_CONSISTENCY_ERROR =
  "load_kg must match entered_load, entered_unit, and load_entry";

function isLoadRepairCandidate(
  item: OutboxItem,
  owner: string | null,
): item is OutboxItem & { op: Extract<OutboxOp, { kind: "insert"; table: "sets" }> } {
  return (
    item.status === "dead" &&
    item.op.kind === "insert" &&
    item.op.table === "sets" &&
    typeof item.user_id === "string" &&
    item.user_id === owner &&
    item.last_code === "23514" &&
    item.last_error === LOAD_CONSISTENCY_ERROR &&
    item.op.payload.entered_load != null &&
    item.op.payload.entered_unit != null
  );
}

export interface RetryOutcome {
  /** dead items put back in the queue */
  requeued: number;
  /** dead items left alone, because the same bytes would be refused again */
  stuck: number;
}

/** One queued write, as the pending-writes view needs to read it. */
export interface OutboxEntry {
  /** IndexedDB key. Also the enqueue order, which is the replay order. */
  key: number;
  op: OutboxOp;
  table: OutboxOp["table"];
  /** null on items queued before the field existed */
  created_at: string | null;
  retries: number;
  last_error: string | null;
  last_code?: string | null;
  last_status?: number | null;
  /** who queued it; undefined on items queued before multi-user, null when
   *  no identity was known at enqueue */
  user_id: string | null | undefined;
  /** Original void keeps the correction join after replacement replay. */
  correction_link?: OutboxItem["correction_link"];
  /**
   * 'waiting' goes on the next flush. 'held' was queued by another account
   * (or before identity resolved) and this device must not send it. 'dead'
   * was refused and the flusher steps over it.
   */
  state: "waiting" | "held" | "dead";
  /** null unless dead */
  cause: DeadKind | null;
  retryable: boolean;
  /** This account may review and repair this exact authored-load failure. */
  loadRepairable?: boolean;
}

interface Row {
  key: number;
  item: OutboxItem;
}

export function createOutbox({
  getDb,
  transport,
  isOnline,
  currentUserId,
  stampUserId,
  onIdentityChange,
  onSynced,
  retryDelaysMs = [5_000, 15_000, 60_000, 300_000],
}: Deps): Outbox {
  let status: OutboxStatus = {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle",
    lastError: null,
  };
  // Flush runs are serialized on a promise chain: overlapping calls each get
  // their own full run (awaiting flush() always means "the queue was walked
  // after I asked"), and two runs can never interleave.
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const syncedListeners = new Set<
    (op: OutboxOp, ownerId: string | null | undefined) => void
  >();

  const online = isOnline ?? (() => navigator.onLine);
  const whoAmI = currentUserId ?? (() => null);
  // With no identity source at all (a single-user outbox) items stay
  // unstamped, exactly as before multi-user.
  const stampOwner: () => string | null | undefined =
    stampUserId ?? currentUserId ?? (() => undefined);

  /**
   * Whether this item may be replayed right now. An item queued by someone
   * else waits for them; it is never flushed as the current user and never
   * discarded. `sets` is append-only, so a wrong owner could not be corrected
   * afterwards — holding is the only safe answer.
   *
   * An UNKNOWN identity holds too, and that is the whole point of this shape.
   * getCurrentUserId() returns null for "signed out" and for "not known yet"
   * alike, and "not known yet" is exactly the state the app boots in: start()
   * flushes after two IndexedDB round-trips, while identity resolution is a
   * network token refresh whenever the stored access token has expired — any
   * next-morning open. IndexedDB wins that race. Treating null as permission
   * meant the first held item was inserted with no user_id in the payload, so
   * the `default auth.uid()` on the column stamped it with whoever happened to
   * be signed in. One person's set, permanently recorded against another, in
   * an append-only table with no correction path.
   *
   * Nothing is lost by waiting: the item stays pending, and start() re-runs
   * the queue the moment identity arrives.
   */
  function replayable(item: OutboxItem): boolean {
    const owner = item.user_id;
    if (owner === undefined) return true; // pre-multi-user item
    // Queued while NO identity was known (A-90). Nothing records whose it is,
    // so no later sign-in may claim it: it stays held and visible.
    if (owner === null) return false;
    return whoAmI() === owner;
  }

  function setStatus(patch: Partial<OutboxStatus>): void {
    status = { ...status, ...patch };
    for (const fn of listeners) fn();
  }

  function normalize(item: OutboxItem): OutboxItem {
    // items written before the dead-letter feature have no status field
    return item.status === "dead" || item.status === "receipt"
      ? item
      : { ...item, status: "pending" };
  }

  async function readAll(db: Database): Promise<Row[]> {
    const out: Row[] = [];
    let cursor = await db.transaction("outbox").store.openCursor();
    while (cursor) {
      out.push({ key: cursor.key, item: normalize(cursor.value) });
      cursor = await cursor.continue();
    }
    return out;
  }

  /**
   * A correction's original void must wait while its replacement is anywhere
   * in the durable queue, including dead letters. Read current IndexedDB state
   * here because an earlier row in this flush may just have been acknowledged
   * and deleted; the flush-start snapshot cannot distinguish that from pending.
   */
  async function correctionReplacementQueued(
    db: Database,
    item: OutboxItem,
  ): Promise<boolean> {
    const link = item.correction_link;
    if (!link) return false;
    const rows = await db.getAll("outbox");
    return rows.some((candidate) =>
      candidate.op.kind === "insert" &&
      candidate.op.table === "sets" &&
      candidate.op.payload.id === link.replacement_id
    );
  }

  function counts(rows: Row[]): {
    pending: number;
    dead: number;
    held: number;
  } {
    let pending = 0;
    let dead = 0;
    let held = 0;
    for (const r of rows) {
      if (r.item.status === "receipt") continue;
      if (r.item.status === "dead") {
        dead++;
      } else {
        pending++;
        if (!replayable(r.item)) held++;
      }
    }
    return { pending, dead, held };
  }

  /**
   * Record a failure on the item. The code and status ride along, not just
   * the message: once the item is dead they are the only evidence left of
   * why, and every caller below has to write the same three fields.
   */
  function withFailure(item: OutboxItem, err: TransportError): OutboxItem {
    return {
      ...item,
      retries: item.retries + 1,
      last_error: err.message,
      last_code: err.code,
      last_status: err.status,
    };
  }

  function makePendingItem(
    op: OutboxOp,
    owner: string | null | undefined,
  ): OutboxItem {
    return {
      op,
      created_at: new Date().toISOString(),
      retries: 0,
      last_error: null,
      status: "pending",
      // null is kept, never omitted: omitting it made an unknown owner look
      // like a pre-multi-user item, which replays as whoever signs in next
      // (A-90). Only an outbox with no identity source leaves it off.
      ...(owner === undefined ? {} : { user_id: owner }),
    };
  }

  async function refreshCounts(): Promise<void> {
    const db = await getDb();
    setStatus(counts(await readAll(db)));
  }

  /**
   * Once an enqueue transaction commits, a count refresh is only a status
   * update. Letting that read reject the enqueue promise makes callers treat
   * a durable write as unsaved and can make them append the same training set
   * again under a new id. Keep the read failure visible without changing the
   * successful commit result.
   */
  async function refreshCountsAfterCommit(): Promise<void> {
    try {
      await refreshCounts();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({
        state: "error",
        lastError: `Write saved locally, but queue status refresh failed: ${message}`,
      });
    }
  }

  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush);
    return chain;
  }

  // Backoff after a retryable failure (A-143). One timer at a time; reset
  // once a flush leaves nothing retryable behind.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  function scheduleRetry(): void {
    if (retryTimer !== null || retryDelaysMs.length === 0) return;
    const delay =
      retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, delay);
  }
  function clearRetry(): void {
    retryAttempt = 0;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function doFlush(): Promise<void> {
    try {
      const db = await getDb();
      const rows = await readAll(db);
      const c = counts(rows);
      if (c.pending === 0) {
        clearRetry();
        setStatus({ ...c, state: "idle" });
        return;
      }
      if (!online()) {
        // offline: keep everything queued, no retries burned; the `online`
        // event flushes again, so no timer is needed
        clearRetry();
        setStatus({ ...c, state: "idle" });
        return;
      }
      setStatus({ ...c, state: "syncing" });

      // Replay pending items strictly in key (enqueue) order, one at a time,
      // skipping dead ones. Stop only on a retryable failure so ordering
      // guarantees hold (a session insert always lands before its sets).
      let authRefreshTried = false;

      for (const row of rows) {
        if (row.item.status === "dead" || row.item.status === "receipt") continue;
        // Someone else's queued work: leave it exactly where it is.
        if (!replayable(row.item)) continue;
        let item = row.item;
        if (
          item.op.kind === "insert" && item.op.table === "set_voids" &&
          item.correction_link && await correctionReplacementQueued(db, item)
        ) {
          // Keep the original set visible until the replacement has actually
          // left the durable queue after an ACK. Continue independent writes.
          continue;
        }

        attempt: for (;;) {
          // Capture the identity used for this request before awaiting transport.
          // For old unstamped rows this is the only owner evidence the ACK can
          // carry; never look up a possibly switched account after the await.
          const requestOwner = whoAmI();
          if (item.user_id !== undefined && item.user_id !== requestOwner) break attempt;
          const operationOwner = item.user_id ?? requestOwner;
          const err = await applyOp(item.op);
          if (err === null) {
            if (item.correction_link && typeof item.user_id === "string") {
              // Keep only the owner-bound relation after the append-only void
              // is acknowledged. Queue readers exclude status=receipt; exact
              // server readback is still required before calling it Synced.
              await db.put("outbox", { ...item, status: "receipt" }, row.key);
            } else {
              await db.delete("outbox", row.key);
            }
            setStatus({ ...counts(await readAll(db)), lastError: null });
            try {
              onSynced?.(item.op);
            } catch {
              // A listener's own bug must never look like a sync failure.
            }
            for (const listener of syncedListeners) {
              try {
                listener(item.op, operationOwner);
              } catch {
                // Receipt listeners cannot turn an ACK into a transport failure.
              }
            }
            break attempt;
          }

          const kind = classify(item.op, err);

          if (kind === "fk-prescription") {
            // prescription deleted server-side: keep the set, drop the link
            const op = item.op as Extract<
              OutboxOp,
              { kind: "insert"; table: "sets" }
            >;
            item = {
              ...withFailure(item, err),
              op: { ...op, payload: { ...op.payload, prescription_id: null } },
            };
            await db.put("outbox", item, row.key);
            continue attempt; // retry once; a second 23503 classifies as dead
          }

          if (kind === "auth" && !authRefreshTried && transport.refreshAuth) {
            authRefreshTried = true;
            let refreshed = false;
            // A refresh that THREW and a refresh that returned false are not
            // the same answer. Returning false means there is no valid
            // session — genuinely an auth failure, and the item is dead.
            // Throwing means we never found out: getSession() timed out on gym
            // wifi, the request was aborted, DNS failed. Treating that as a
            // verdict dead-lettered the entire queue for a transient
            // condition, and because authRefreshTried is per-flush, every
            // following item skipped the refresh and went straight to dead
            // too — a 25-set session showing as 25 failures because one
            // request took too long.
            let unreachable = false;
            try {
              refreshed = await transport.refreshAuth();
            } catch {
              unreachable = true;
            }
            if (refreshed) {
              item = withFailure(item, err);
              await db.put("outbox", item, row.key);
              continue attempt;
            }
            if (unreachable) {
              // fall through to the retryable path: stay pending, stop the
              // flush, try again on the next trigger
              item = withFailure(item, err);
              await db.put("outbox", item, row.key);
              setStatus({
                ...counts(await readAll(db)),
                state: "error",
                lastError: err.message,
              });
              scheduleRetry();
              return;
            }
            // refresh answered, and the answer was no: park below
          }

          if (kind === "dead" || kind === "auth") {
            item = { ...withFailure(item, err), status: "dead" };
            await db.put("outbox", item, row.key);
            setStatus({
              ...counts(await readAll(db)),
              lastError: err.message,
            });
            break attempt; // keep flushing past dead items
          }

          // retryable: record the failure and stop the whole flush
          item = withFailure(item, err);
          await db.put("outbox", item, row.key);
          setStatus({
            ...counts(await readAll(db)),
            state: "error",
            lastError: err.message,
          });
          scheduleRetry();
          return;
        }
      }

      // Nothing retryable is left (sent, dead or held), so stop backing off.
      clearRetry();
      const final = counts(await readAll(db));
      setStatus({ ...final, state: "idle" });
    } catch (e) {
      // IndexedDB itself failed; queue is untouched, surface the error.
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ state: "error", lastError: message });
    }
  }

  async function applyOp(op: OutboxOp): Promise<TransportError | null> {
    try {
      if (op.kind === "insert")
        return await transport.insert(op.table, op.payload);
      return await transport.update(op.table, op.id, op.patch);
    } catch (e) {
      return {
        message: e instanceof Error ? e.message : String(e),
        code: null,
        status: null,
      };
    }
  }

  return {
    async enqueue(op) {
      const db = await getDb();
      await db.add("outbox", makePendingItem(op, stampOwner()));
      await refreshCountsAfterCommit();
      void flush();
    },

    async enqueueBatch(ops) {
      if (ops.length === 0) return;
      const db = await getDb();
      const owner = stampOwner();
      const tx = db.transaction("outbox", "readwrite");
      for (const op of ops) {
        await tx.store.add(makePendingItem(op, owner));
      }
      await tx.done;
      await refreshCountsAfterCommit();
      void flush();
    },

    async enqueueCorrection(sessionId, replacement, originalId) {
      const db = await getDb();
      const owner = stampOwner();
      const tx = db.transaction(["outbox", "kv"], "readwrite");
      const txDone = tx.done;
      // Observe aborts immediately, since a request may reject before we
      // reach the await below and IndexedDB then rejects `done` as well.
      void txDone.catch(() => undefined);
      const outboxStore = tx.objectStore("outbox");
      const kvStore = tx.objectStore("kv");
      const linkKey = cacheKeys.sessionCorrectionLinks(sessionId);
      try {
        await outboxStore.add(makePendingItem(
          { kind: "insert", table: "sets", payload: replacement },
          owner,
        ));
        await outboxStore.add({
          ...makePendingItem(
          { kind: "insert", table: "set_voids", payload: { set_id: originalId } },
          owner,
          ),
          correction_link: {
            session_id: sessionId,
            replacement_id: replacement.id,
            original_id: originalId,
          },
        });
        const links = (await kvStore.get(linkKey) as Record<string, string> | undefined) ?? {};
        await kvStore.put({ ...links, [replacement.id]: originalId }, linkKey);
        await txDone;
      } catch (error) {
        try { tx.abort(); } catch { /* transaction may already have aborted */ }
        await txDone.catch(() => undefined);
        throw error;
      }
      await refreshCountsAfterCommit();
      void flush();
    },

    flush,

    async retryDead() {
      const db = await getDb();
      let requeued = 0;
      let stuck = 0;
      const rows = await readAll(db);
      const queuedSetIds = new Set(rows.flatMap(({ item }) =>
        item.op.kind === "insert" && item.op.table === "sets" ? [item.op.payload.id] : []));
      const retryingSetIds = new Set(rows.flatMap(({ item }) =>
        item.status === "dead" && isRetryable(item) &&
        item.op.kind === "insert" && item.op.table === "sets"
          ? [item.op.payload.id]
          : []));
      for (const row of rows) {
        if (row.item.status !== "dead") continue;
        const correctionLink = row.item.correction_link;
        if (correctionLink && row.item.op.kind === "insert" &&
            row.item.op.table === "set_voids") {
          const replacementQueued = await correctionReplacementQueued(db, row.item);
          if (replacementQueued && !retryingSetIds.has(correctionLink.replacement_id)) {
            stuck++;
            continue;
          }
        }
        // A refused void/note cannot pass RLS until its parent set is on the
        // server. Keep it parked while that set remains anywhere in this queue.
        if (row.item.op.kind === "insert" &&
            (row.item.op.table === "set_voids" || row.item.op.table === "set_notes") &&
            queuedSetIds.has(row.item.op.payload.set_id)) {
          stuck++;
          continue;
        }
        // A row the server rejected on its own merits comes back refused, and
        // a retry that re-queues it only moves it from FAILED to FAILED via a
        // moment of false hope. It stays dead and stays exportable.
        if (!isRetryable(row.item)) {
          stuck++;
          continue;
        }
        await db.put("outbox", { ...row.item, status: "pending" }, row.key);
        requeued++;
      }
      await refreshCounts();
      // Nothing was un-parked, so there is nothing new for a flush to find.
      if (requeued > 0) await flush();
      return { requeued, stuck };
    },

    async repairDeadLoadSet(key, expected) {
      const db = await getDb();
      const tx = db.transaction("outbox", "readwrite");
      const item = await tx.store.get(key);
      if (
        !item ||
        !isLoadRepairCandidate(item, whoAmI()) ||
        JSON.stringify(item.op.payload) !== JSON.stringify(expected)
      ) {
        await tx.done;
        return false;
      }
      // The exported payload retains the original authored value. Null here
      // means unknown, never a fabricated claim that the lifter typed kg.
      await tx.store.put(
        {
          ...item,
          op: {
            ...item.op,
            payload: { ...item.op.payload, entered_load: null, entered_unit: null },
          },
          status: "pending",
          last_error: null,
          last_code: null,
          last_status: null,
        },
        key,
      );
      await tx.done;
      await refreshCountsAfterCommit();
      await flush();
      return true;
    },

    async repairDeadLoadSets(expected) {
      const owner = whoAmI();
      if (!owner || expected.length === 0 || new Set(expected.map((e) => e.key)).size !== expected.length) return false;
      const db = await getDb();
      const tx = db.transaction("outbox", "readwrite");
      const keys = await tx.store.getAllKeys();
      const current = await Promise.all(keys.map(async (key) => ({ key, item: await tx.store.get(key) })));
      const eligible = current.filter((row) => row.item && isLoadRepairCandidate(row.item, owner));
      const selected = new Map(expected.map((row) => [row.key, row]));
      // Compare the whole exported entry, not only the payload: retries,
      // error cause, owner and queue position are part of the reviewed copy.
      const valid = eligible.length === expected.length && eligible.every(({ key, item }) => {
        const saved = selected.get(key);
        return Boolean(item && saved && saved.loadRepairable === true &&
          saved.state === "dead" && saved.user_id === owner &&
          saved.created_at === (item.created_at ?? null) &&
          saved.retries === (item.retries ?? 0) &&
          saved.last_error === (item.last_error ?? null) &&
          saved.last_code === (item.last_code ?? null) &&
          saved.last_status === (item.last_status ?? null) &&
          saved.cause === deadKind(item.last_code, item.last_status) &&
          JSON.stringify(saved.op) === JSON.stringify(item.op));
      });
      if (!valid || whoAmI() !== owner) {
        await tx.done;
        return false;
      }
      for (const { key, item } of eligible) {
        if (!item || !isLoadRepairCandidate(item, owner)) {
          tx.abort();
          return false;
        }
        await tx.store.put({
          ...item,
          op: { ...item.op, payload: { ...item.op.payload, entered_load: null, entered_unit: null } },
          status: "pending",
          last_error: null,
          last_code: null,
          last_status: null,
        }, key);
      }
      await tx.done;
      await refreshCountsAfterCommit();
      void flush();
      return true;
    },

    async inspect() {
      const db = await getDb();
      const rows = await readAll(db);
      return rows.filter(({ item }) => item.status !== "receipt").map(({ key, item }): OutboxEntry => {
        const dead = item.status === "dead";
        return {
          key,
          op: item.op,
          table: item.op.table,
          created_at: item.created_at ?? null,
          retries: item.retries ?? 0,
          last_error: item.last_error ?? null,
          last_code: item.last_code ?? null,
          last_status: item.last_status ?? null,
          user_id: item.user_id,
          correction_link: item.correction_link,
          state: dead ? "dead" : replayable(item) ? "waiting" : "held",
          cause: dead ? deadKind(item.last_code, item.last_status) : null,
          retryable: dead && isRetryable(item),
          loadRepairable: isLoadRepairCandidate(item, whoAmI()),
        };
      });
    },

    getStatus: () => status,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    subscribeSynced(fn) {
      syncedListeners.add(fn);
      return () => syncedListeners.delete(fn);
    },

    async pendingSets(sessionId) {
      const db = await getDb();
      const rows = await readAll(db);
      return rows
        .map((r) => r.item.op)
        .filter(
          (op): op is Extract<OutboxOp, { kind: "insert"; table: "sets" }> =>
            op.kind === "insert" && op.table === "sets",
        )
        .map((op) => op.payload)
        .filter((s) => s.session_id === sessionId);
    },

    async pendingSessionUpdateIds() {
      const db = await getDb();
      const rows = await readAll(db);
      return new Set(
        rows
          .map((r) => r.item.op)
          .filter(
            (
              op,
            ): op is Extract<OutboxOp, { kind: "update"; table: "sessions" }> =>
              op.kind === "update" && op.table === "sessions",
          )
          .map((op) => op.id),
      );
    },

    async pendingVoidIds() {
      const db = await getDb();
      const rows = await readAll(db);
      return new Set(
        rows.filter(({ item }) => item.status !== "receipt")
          .map((r) => r.item.op)
          .filter(
            (
              op,
            ): op is Extract<
              OutboxOp,
              { kind: "insert"; table: "set_voids" }
            > => op.kind === "insert" && op.table === "set_voids",
          )
          .map((op) => op.payload.set_id),
      );
    },

    async pendingDiscardIds() {
      const db = await getDb();
      const rows = await readAll(db);
      return new Set(
        rows
          // A failed discard has been refused by the server. Keeping it in
          // this optimistic-hide set would make the session disappear from
          // this device's history even though Postgres kept it live.
          .filter((r) => r.item.status !== "dead")
          .map((r) => r.item.op)
          .filter(
            (
              op,
            ): op is Extract<OutboxOp, { kind: "update"; table: "sessions" }> =>
              op.kind === "update" && op.table === "sessions",
          )
          // an end patch and a discard patch share a table and an id; only the
          // shape tells them apart
          .filter((op) => "discarded_at" in op.patch)
          .map((op) => op.id),
      );
    },

    async pendingRatedSessionIds() {
      const db = await getDb();
      const rows = await readAll(db);
      return new Set(
        rows
          .map((r) => r.item.op)
          .filter(
            (
              op,
            ): op is Extract<OutboxOp, { kind: "update"; table: "sessions" }> =>
              op.kind === "update" && op.table === "sessions",
          )
          // A finish carries session_rpe too, and it counts: a session ended
          // WITH a rating that has not flushed yet is a rated session, and
          // asking again would be the same duplicate prompt. What is excluded
          // is a finish that left it null, and a discard, which has no
          // session_rpe key at all.
          .filter(
            (op) => "session_rpe" in op.patch && op.patch.session_rpe !== null,
          )
          .map((op) => op.id),
      );
    },

    async correctionLinks(sessionId) {
      const owner = whoAmI();
      if (!owner) return {};
      const rows = await readAll(await getDb());
      const links: Record<string, string> = {};
      for (const { item } of rows) {
        const link = item.correction_link;
        if (item.user_id === owner && link?.session_id === sessionId) {
          links[link.replacement_id] = link.original_id;
        }
      }
      return links;
    },

    start() {
      window.addEventListener("online", () => void flush());
      // A phone that comes back from being locked or backgrounded does not
      // always fire `online` — the connection was never lost, the tab was
      // just asleep — so a write queued right before it locked could sit
      // there until the next unrelated write nudged the queue. Foreground
      // is exactly when someone is looking at the sync pill wondering why
      // it still says QUEUED. `document` does not exist in every test
      // environment this file runs under (outbox.test.ts is node, not
      // jsdom), so the listener is skippable there rather than a hard
      // dependency.
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void flush();
        });
      }
      // Identity arrives asynchronously and usually AFTER this first flush.
      // Items stamped with an owner are held until it does (see `replayable`),
      // so the queue has to be walked again once we know who we are — without
      // this, a boot-time queue waits for the next `online` event or the next
      // write, which for someone who opens the app just to check yesterday is
      // never.
      onIdentityChange?.(() => void flush());
      void refreshCounts().then(() => void flush());
    },
  };
}
