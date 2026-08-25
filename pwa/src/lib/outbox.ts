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
//    -> mark 'dead': kept in IndexedDB with last_error, skipped by the
//    flusher, surfaced in SyncStatus with a "retry failed" action
// The flusher keeps going past dead items.
//
// The outbox knows nothing about screens; screens know nothing about sync.

import type { Database, OutboxItem, OutboxOp } from "./db";
import type { SetInsert } from "./types";

export type SyncState = "idle" | "syncing" | "error";

export interface OutboxStatus {
  pending: number;
  dead: number;
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
  /** upsert with { onConflict: 'id', ignoreDuplicates: true }; null on success */
  insert(
    table: "sessions" | "sets",
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
  /** re-queue all dead items as pending and flush */
  retryDead(): Promise<void>;
  getStatus(): OutboxStatus;
  subscribe(fn: () => void): () => void;
  /** Queued (unsynced) set inserts for a session — dead ones included, the
   *  user logged them and the UI must reflect them. */
  pendingSets(sessionId: string): Promise<SetInsert[]>;
  /** Wire up app-start + 'online' triggers. */
  start(): void;
}

interface Deps {
  getDb: () => Promise<Database>;
  transport: OutboxTransport;
  isOnline?: () => boolean;
}

type ErrorClass = "retry" | "dead" | "auth" | "fk-prescription";

function classify(op: OutboxOp, err: TransportError): ErrorClass {
  if (
    err.code === "23503" &&
    op.kind === "insert" &&
    op.table === "sets" &&
    op.payload.prescription_id !== null
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

interface Row {
  key: number;
  item: OutboxItem;
}

export function createOutbox({ getDb, transport, isOnline }: Deps): Outbox {
  let status: OutboxStatus = {
    pending: 0,
    dead: 0,
    state: "idle",
    lastError: null,
  };
  // Flush runs are serialized on a promise chain: overlapping calls each get
  // their own full run (awaiting flush() always means "the queue was walked
  // after I asked"), and two runs can never interleave.
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const online = isOnline ?? (() => navigator.onLine);

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

  function counts(rows: Row[]): { pending: number; dead: number } {
    let pending = 0;
    let dead = 0;
    for (const r of rows) {
      if (r.item.status === "dead") dead++;
      else pending++;
    }
    return { pending, dead };
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
              ...item,
              op: { ...op, payload: { ...op.payload, prescription_id: null } },
              retries: item.retries + 1,
              last_error: err.message,
            };
            await db.put("outbox", item, row.key);
            continue attempt; // retry once; a second 23503 classifies as dead
          }

          if (kind === "auth" && !authRefreshTried && transport.refreshAuth) {
            authRefreshTried = true;
            let refreshed = false;
            try {
              refreshed = await transport.refreshAuth();
            } catch {
              refreshed = false;
            }
            if (refreshed) {
              item = {
                ...item,
                retries: item.retries + 1,
                last_error: err.message,
              };
              await db.put("outbox", item, row.key);
              continue attempt;
            }
            // refresh didn't help: park below
          }

          if (kind === "dead" || kind === "auth") {
            item = {
              ...item,
              status: "dead",
              retries: item.retries + 1,
              last_error: err.message,
            };
            await db.put("outbox", item, row.key);
            setStatus({
              ...counts(await readAll(db)),
              lastError: err.message,
            });
            break attempt; // keep flushing past dead items
          }

          // retryable: record the failure and stop the whole flush
          item = {
            ...item,
            retries: item.retries + 1,
            last_error: err.message,
          };
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
      const item: OutboxItem = {
        op,
        created_at: new Date().toISOString(),
        retries: 0,
        last_error: null,
        status: "pending",
      };
      await db.add("outbox", item);
      await refreshCounts();
      void flush();
    },

    flush,

    async retryDead() {
      const db = await getDb();
      for (const row of await readAll(db)) {
        if (row.item.status === "dead") {
          await db.put("outbox", { ...row.item, status: "pending" }, row.key);
        }
      }
      await refreshCounts();
      await flush();
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

    start() {
      window.addEventListener("online", () => void flush());
      void refreshCounts().then(() => void flush());
    },
  };
}
