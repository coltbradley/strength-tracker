// What a FINISHED session can honestly claim about the server.
//
// The Train confirmation used to infer "all sets on the server" from an empty
// outbox, which is an absence of evidence. The Session screen already has
// stronger proof: a per-set receipt that is "synced" only when the server
// returned that exact set UUID (`projectSetReceipt`). This reads the same
// evidence for a session that has ended, so the sync line can say "6 sets
// confirmed on the server" only when each of them was read back by UUID.
//
// Evidence only ever adds: a failed read, an unknown owner or a session this
// phone holds no sets for return null, and the caller falls back to what the
// outbox can say. Nothing here writes.

import { cacheGet, cacheKeys } from "./db";
import { getExactSetReceiptIds } from "./data";
import { outbox } from "./sync";
import { projectSetReceipt } from "./setReceipt";
import { reportError } from "./errors";
import type { SetInsert } from "./types";

export interface FinishedSessionProof {
  /** live sets of the session this phone knows about */
  sets: number;
  /** of those, receipts that are "synced" by exact UUID readback */
  confirmed: number;
  /** of those, anything else: still queued, held, rejected or not read back */
  unconfirmed: number;
}

export async function readFinishedSessionProof(
  sessionId: string,
  ownerId: string,
): Promise<FinishedSessionProof | null> {
  try {
    const [cached, entries, links] = await Promise.all([
      cacheGet<SetInsert[]>(cacheKeys.sessionSets(sessionId)),
      outbox.inspect(),
      outbox.correctionLinks(sessionId),
    ]);
    const byId = new Map<string, SetInsert>();
    for (const set of cached ?? []) {
      if (set.session_id === sessionId) byId.set(set.id, set);
    }
    for (const entry of entries) {
      if (entry.user_id !== ownerId && entry.user_id !== undefined) continue;
      if (
        entry.op.kind === "insert" &&
        entry.op.table === "sets" &&
        entry.op.payload.session_id === sessionId
      ) {
        byId.set(entry.op.payload.id, entry.op.payload);
      }
    }
    // A corrected original is a void, not a set the lifter did.
    const originals = new Set(Object.values(links));
    const live = [...byId.keys()].filter((id) => !originals.has(id));
    if (live.length === 0) return null;
    const exact = await getExactSetReceiptIds(sessionId, ownerId, [
      ...live,
      ...originals,
    ]);
    let confirmed = 0;
    for (const setId of live) {
      const receipt = projectSetReceipt({
        setId,
        ownerId,
        serverSetIds: exact.setIds,
        serverVoidIds: exact.voidIds,
        entries,
        correctionOf: links[setId],
      });
      if (receipt.state === "synced") confirmed += 1;
    }
    return { sets: live.length, confirmed, unconfirmed: live.length - confirmed };
  } catch (error) {
    reportError(error, "read finished session receipts");
    return null;
  }
}
