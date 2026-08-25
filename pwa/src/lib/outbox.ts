// Offline write queue. EVERY write goes here first; a flusher replays the
// queue to Supabase strictly in enqueue order. Inserts use upsert with
// ignoreDuplicates (on conflict do nothing) + client-generated UUIDs, so
// replay after a partial failure is idempotent. Session end is a plain
// update, idempotent by nature. Failed items stay queued with a retry count
// and last error — a write is NEVER silently dropped.
//
// The outbox knows nothing about screens; screens know nothing about sync.

import type { Database, OutboxItem, OutboxOp } from "./db";
import type { SetInsert } from "./types";

export type SyncState = "idle" | "syncing" | "error";

export interface OutboxStatus {
  pending: number;
  state: SyncState;
  lastError: string | null;
}

/** The two Supabase calls the outbox needs, abstracted for tests. */
export interface OutboxTransport {
  /** upsert with { onConflict: 'id', ignoreDuplicates: true }; null on success, error message on failure */
  insert(table: "sessions" | "sets", payload: unknown): Promise<string | null>;
  update(table: "sessions", id: string, patch: unknown): Promise<string | null>;
}

export interface Outbox {
  enqueue(op: OutboxOp): Promise<void>;
  flush(): Promise<void>;
  getStatus(): OutboxStatus;
  subscribe(fn: () => void): () => void;
  /** Queued (unsynced) set inserts for a session, in enqueue order. */
  pendingSets(sessionId: string): Promise<SetInsert[]>;
  /** Wire up app-start + 'online' triggers. */
  start(): void;
}

interface Deps {
  getDb: () => Promise<Database>;
  transport: OutboxTransport;
  isOnline?: () => boolean;
}

export function createOutbox({ getDb, transport, isOnline }: Deps): Outbox {
  let status: OutboxStatus = { pending: 0, state: "idle", lastError: null };
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

  async function refreshPending(): Promise<number> {
    const db = await getDb();
    const pending = await db.count("outbox");
    setStatus({ pending });
    return pending;
  }

  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush);
    return chain;
  }

  async function doFlush(): Promise<void> {
    try {
      const db = await getDb();
      let pending = await db.count("outbox");
      if (pending === 0) {
        setStatus({ pending: 0, state: "idle", lastError: null });
        return;
      }
      if (!online()) {
        // offline: keep everything queued, no retries burned
        setStatus({ pending, state: "idle" });
        return;
      }
      setStatus({ pending, state: "syncing" });

      // Replay strictly in key (enqueue) order, one at a time. Stop on the
      // first failure so ordering guarantees hold (a session insert always
      // lands before its sets).
      for (;;) {
        const tx = db.transaction("outbox", "readonly");
        const cursor = await tx.store.openCursor();
        if (!cursor) break;
        const key = cursor.key;
        const item = cursor.value;
        await tx.done;

        const error = await applyOp(item.op);
        if (error === null) {
          await db.delete("outbox", key);
          pending = await db.count("outbox");
          setStatus({ pending, lastError: null });
        } else {
          const updated: OutboxItem = {
            ...item,
            retries: item.retries + 1,
            last_error: error,
          };
          await db.put("outbox", updated, key);
          setStatus({ pending, state: "error", lastError: error });
          return;
        }
      }
      setStatus({ pending: 0, state: "idle", lastError: null });
    } catch (e) {
      // IndexedDB itself failed; queue is untouched, surface the error.
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ state: "error", lastError: message });
    }
  }

  async function applyOp(op: OutboxOp): Promise<string | null> {
    try {
      if (op.kind === "insert")
        return await transport.insert(op.table, op.payload);
      return await transport.update(op.table, op.id, op.patch);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
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
      };
      await db.add("outbox", item);
      await refreshPending();
      void flush();
    },

    flush,

    getStatus: () => status,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async pendingSets(sessionId) {
      const db = await getDb();
      const items = await db.getAll("outbox");
      return items
        .filter(
          (
            i,
          ): i is OutboxItem & {
            op: { kind: "insert"; table: "sets"; payload: SetInsert };
          } => i.op.kind === "insert" && i.op.table === "sets",
        )
        .map((i) => i.op.payload)
        .filter((s) => s.session_id === sessionId);
    },

    start() {
      window.addEventListener("online", () => void flush());
      void refreshPending().then(() => void flush());
    },
  };
}
