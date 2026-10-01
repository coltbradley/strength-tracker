import type { OutboxEntry } from "./outbox";

export type SetReceipt = {
  state: "local" | "synced" | "review";
  reason?: string;
};

export interface SetReceiptInput {
  setId: string;
  ownerId: string;
  serverSetIds: ReadonlySet<string>;
  /** Set UUIDs from authenticated set_voids.set_id readback. */
  serverVoidIds: ReadonlySet<string>;
  entries: readonly OutboxEntry[];
  /** Original set UUID from the durable replacement -> original link. */
  correctionOf?: string;
}

function ownerMatches(entry: OutboxEntry, ownerId: string): boolean {
  // Legacy operations predate owner stamping and remain compatible with the
  // signed-in owner. Null is unknown and must never be claimed.
  return entry.user_id === undefined || entry.user_id === ownerId;
}

function opMatchesSet(entry: OutboxEntry, setId: string): boolean {
  return entry.op.kind === "insert" && entry.op.table === "sets" &&
    entry.op.payload.id === setId;
}

function opMatchesVoid(entry: OutboxEntry, setId: string): boolean {
  // set_voids is keyed by the original set UUID in payload.set_id. There is
  // no void-row UUID to compare against a set receipt.
  return entry.op.kind === "insert" && entry.op.table === "set_voids" &&
    entry.op.payload.set_id === setId;
}

function review(reason: string): SetReceipt {
  return { state: "review", reason };
}

export function projectSetReceipt(input: SetReceiptInput): SetReceipt {
  const { setId, ownerId, serverSetIds, serverVoidIds, entries } = input;
  const relevant = entries.filter((entry) =>
    opMatchesSet(entry, setId) || opMatchesVoid(entry, input.correctionOf ?? setId) ||
    entry.correction_link?.replacement_id === setId
  );
  const unknownOwner = relevant.find((entry) => entry.user_id === null);
  if (unknownOwner) return review("The queued write has no known owner.");
  const foreignCorrection = relevant.find((entry) =>
    entry.correction_link?.replacement_id === setId &&
    entry.user_id !== undefined && entry.user_id !== ownerId
  );
  if (foreignCorrection) return review("Correction metadata belongs to another owner.");

  const own = relevant.filter((entry) => ownerMatches(entry, ownerId));
  const correctionOf = input.correctionOf ?? own.find((entry) =>
    entry.correction_link?.replacement_id === setId
  )?.correction_link?.original_id;
  const setOps = own.filter((entry) => opMatchesSet(entry, setId));
  const voidOps = own.filter((entry) => opMatchesVoid(entry, correctionOf ?? setId));
  const rejected = [...setOps, ...voidOps].find((entry) => entry.state === "dead");
  const replacementOnServer = serverSetIds.has(setId);
  const voidOnServer = serverVoidIds.has(correctionOf ?? setId);

  if (correctionOf !== undefined) {
    if (replacementOnServer && voidOnServer) return { state: "synced" };
    if (rejected) {
      // The replacement is on the server but the void of the original was
      // refused: both rows are live there until somebody retries it.
      if (replacementOnServer && opMatchesVoid(rejected, correctionOf))
        return review(
          `The corrected set is saved, but the void of the original was rejected. Both are live on the server until it is retried.${rejected.last_error ? ` ${rejected.last_error}` : ""}`,
        );
      return review(rejected.last_error ?? "A correction write was rejected.");
    }
    if (setOps.length > 0 || voidOps.length > 0) return { state: "local" };
    return review("Exact replacement and original void evidence is incomplete.");
  }

  if (serverVoidIds.has(setId)) {
    return serverSetIds.has(setId)
      ? { state: "synced" }
      : review("The void is confirmed, but the set row was not read back.");
  }
  if (rejected) return review(rejected.last_error ?? "A set write was rejected.");
  if (voidOps.length > 0) return { state: "local" };
  if (replacementOnServer) return { state: "synced" };
  if (setOps.length > 0) return { state: "local" };
  return review("No exact server or queued operation confirms this set.");
}

/**
 * Whether the queued writes for this set are HELD: this device must not send
 * them (another account's, or queued before identity resolved). A held write
 * is on the phone and healthy, but it is not "sending" and says so.
 */
export function setQueueHeld(
  entries: readonly OutboxEntry[],
  setId: string,
  correctionOf?: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.state === "held" &&
      (opMatchesSet(entry, setId) ||
        opMatchesVoid(entry, correctionOf ?? setId) ||
        entry.correction_link?.replacement_id === setId),
  );
}

/**
 * A correction is TWO rows on the server until its void lands: the original
 * stays live (and counted in volume and e1RM) while the void is held behind the
 * replacement, which is the right order (insert before void) but an unbounded
 * window. While the replacement's receipt is still "local" (queued, sending or
 * held), this names the pair so the phone never looks finished when the server
 * still holds both. Null when the set is not a correction or the pair has
 * resolved. `review` shows its own state; `synced` is done.
 */
export function correctionWaiting(
  receipt: SetReceipt,
  correctionLinks: Readonly<Record<string, string>>,
  setId: string,
): { originalId: string } | null {
  const originalId = correctionLinks[setId];
  if (originalId === undefined || receipt.state !== "local") return null;
  return { originalId };
}
