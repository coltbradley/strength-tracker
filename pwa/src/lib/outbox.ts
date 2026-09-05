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

import type { Database, OutboxItem, OutboxOp } from "./db";
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
    table: "sessions" | "sets" | "set_voids" | "set_notes",
    payload: unknown,
  ): Promise<TransportError | null>;
  update(
    table: "sessions",
    id: string,
    patch: unknown,
  ): Promise<TransportError | null>;
  /** try to refresh the auth session; true if a valid session exists after */
  refreshAuth?(): Promise<boolean>;
}

export interface Outbox {
  enqueue(op: OutboxOp): Promise<void>;
  flush(): Promise<void>;
  /**
   * Re-queue the dead items a retry could actually help, and flush. Items
   * the server refused on the merits of the row itself are left where they
   * are — see `deadKind`. Returns what it did, so the caller can say so
   * instead of implying a rescue that never happened.
   */
  retryDead(): Promise<RetryOutcome>;
  /**
   * Every queued item, in replay order, for the pending-writes view. The one
   * READ of the queue as a queue: everything else here asks it a question
   * about one session or one set.
   */
  inspect(): Promise<OutboxEntry[]>;
  getStatus(): OutboxStatus;
  subscribe(fn: () => void): () => void;
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
   * Subscribe to identity changes; returns an unsubscribe. Because an unknown
   * identity now HOLDS stamped items (see `replayable`), something has to run
   * the queue again once identity arrives, or a queue that was held at boot
   * would sit there until the next `online` event or the next write.
   */
  onIdentityChange?: (fn: (id: string | null) => void) => () => void;
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
  if (code === "42501" || code === "23503" || status === 403) return "blocked";
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
  /** who queued it; undefined on items queued before multi-user */
  user_id: string | undefined;
  /**
   * 'waiting' goes on the next flush. 'held' was queued by another account
   * (or before identity resolved) and this device must not send it. 'dead'
   * was refused and the flusher steps over it.
   */
  state: "waiting" | "held" | "dead";
  /** null unless dead */
  cause: DeadKind | null;
  retryable: boolean;
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
  onIdentityChange,
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

  const online = isOnline ?? (() => navigator.onLine);
  const whoAmI = currentUserId ?? (() => null);

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
    return whoAmI() === owner;
  }

  function setStatus(patch: Partial<OutboxStatus>): void {
    status = { ...status, ...patch };
    for (const fn of listeners) fn();
  }

  function normalize(item: OutboxItem): OutboxItem {
    // items written before the dead-letter feature have no status field
    return item.status === "dead" ? item : { ...item, status: "pending" };
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

  function counts(rows: Row[]): {
    pending: number;
    dead: number;
    held: number;
  } {
    let pending = 0;
    let dead = 0;
    let held = 0;
    for (const r of rows) {
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

  async function refreshCounts(): Promise<void> {
    const db = await getDb();
    setStatus(counts(await readAll(db)));
  }

  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush);
    return chain;
  }

  async function doFlush(): Promise<void> {
    try {
      const db = await getDb();
      const rows = await readAll(db);
      const c = counts(rows);
      if (c.pending === 0) {
        setStatus({ ...c, state: "idle" });
        return;
      }
      if (!online()) {
        // offline: keep everything queued, no retries burned
        setStatus({ ...c, state: "idle" });
        return;
      }
      setStatus({ ...c, state: "syncing" });

      // Replay pending items strictly in key (enqueue) order, one at a time,
      // skipping dead ones. Stop only on a retryable failure so ordering
      // guarantees hold (a session insert always lands before its sets).
      let authRefreshTried = false;

      for (const row of rows) {
        if (row.item.status === "dead") continue;
        // Someone else's queued work: leave it exactly where it is.
        if (!replayable(row.item)) continue;
        let item = row.item;

        attempt: for (;;) {
          const err = await applyOp(item.op);
          if (err === null) {
            await db.delete("outbox", row.key);
            setStatus({ ...counts(await readAll(db)), lastError: null });
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
          return;
        }
      }

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
      const owner = whoAmI();
      const item: OutboxItem = {
        op,
        created_at: new Date().toISOString(),
        retries: 0,
        last_error: null,
        status: "pending",
        ...(owner === null ? {} : { user_id: owner }),
      };
      await db.add("outbox", item);
      await refreshCounts();
      void flush();
    },

    flush,

    async retryDead() {
      const db = await getDb();
      let requeued = 0;
      let stuck = 0;
      for (const row of await readAll(db)) {
        if (row.item.status !== "dead") continue;
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

    async inspect() {
      const db = await getDb();
      const rows = await readAll(db);
      return rows.map(({ key, item }): OutboxEntry => {
        const dead = item.status === "dead";
        return {
          key,
          op: item.op,
          table: item.op.table,
          created_at: item.created_at ?? null,
          retries: item.retries ?? 0,
          last_error: item.last_error ?? null,
          user_id: item.user_id,
          state: dead ? "dead" : replayable(item) ? "waiting" : "held",
          cause: dead ? deadKind(item.last_code, item.last_status) : null,
          retryable: dead && isRetryable(item),
        };
      });
    },

    getStatus: () => status,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
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
        rows
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

    start() {
      window.addEventListener("online", () => void flush());
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
