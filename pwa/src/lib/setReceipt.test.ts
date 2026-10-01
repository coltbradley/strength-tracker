import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./outbox";
import { correctionWaiting, projectSetReceipt, setQueueHeld } from "./setReceipt";

const ownerId = "alice";
const originalId = "set-original";
const replacementId = "set-replacement";

function entry(
  table: "sets" | "set_voids",
  id: string,
  state: OutboxEntry["state"] = "waiting",
  user_id: OutboxEntry["user_id"] = ownerId,
): OutboxEntry {
  return {
    key: table === "sets" ? 1 : 2,
    op: table === "sets"
      ? { kind: "insert", table, payload: { id } as never }
      : { kind: "insert", table, payload: { set_id: id } },
    table,
    created_at: null,
    retries: 0,
    last_error: state === "dead" ? "permission denied" : null,
    last_code: state === "dead" ? "42501" : null,
    last_status: state === "dead" ? 403 : null,
    user_id,
    state,
    cause: state === "dead" ? "blocked" : null,
    retryable: state === "dead",
  };
}

const project = (overrides: Partial<Parameters<typeof projectSetReceipt>[0]> = {}) =>
  projectSetReceipt({
    setId: replacementId,
    ownerId,
    serverSetIds: new Set(),
    serverVoidIds: new Set(),
    entries: [],
    ...overrides,
  });

describe("projectSetReceipt", () => {
  it("calls an exactly queued set local", () => {
    expect(project({ entries: [entry("sets", replacementId)] })).toEqual({ state: "local" });
  });

  it("calls an exact server set synced", () => {
    expect(project({ serverSetIds: new Set([replacementId]) })).toEqual({ state: "synced" });
  });

  it("does not mistake another set's server row for this set", () => {
    expect(project({ serverSetIds: new Set([originalId]) })).toMatchObject({ state: "review" });
  });

  it("treats unknown-owner writes as review", () => {
    expect(project({ entries: [entry("sets", replacementId, "waiting", null)] }))
      .toMatchObject({ state: "review" });
  });

  it("does not use a different owner's operation as this user's receipt", () => {
    expect(project({ entries: [entry("sets", replacementId, "waiting", "bob")] }))
      .toMatchObject({ state: "review" });
  });

  it("puts a rejected exact operation in review", () => {
    expect(project({ entries: [entry("sets", replacementId, "dead")] }))
      .toMatchObject({ state: "review", reason: expect.stringMatching(/permission/i) });
  });

  it("requires exact replacement and original void readback for a correction", () => {
    expect(project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
    })).toMatchObject({ state: "review" });
    expect(project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
      serverVoidIds: new Set([originalId]),
    })).toEqual({ state: "synced" });
  });

  it("matches set_voids.set_id for a correction, not a void row id", () => {
    expect(project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
      serverVoidIds: new Set(["void-row-id"]),
      entries: [entry("set_voids", originalId)],
    })).toMatchObject({ state: "local" });
  });

  it("keeps a replacement local while its exact original void is pending", () => {
    expect(project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
      entries: [entry("set_voids", originalId)],
    })).toEqual({ state: "local" });
  });

  it("recovers the correction relation from its owner-held void after KV cache loss", () => {
    const pendingVoid = {
      ...entry("set_voids", originalId),
      correction_link: {
        session_id: "session-1",
        replacement_id: replacementId,
        original_id: originalId,
      },
    };
    expect(project({
      serverSetIds: new Set([replacementId]),
      entries: [pendingVoid],
    })).toEqual({ state: "local" });
    expect(project({
      serverSetIds: new Set([replacementId]),
      entries: [{ ...pendingVoid, user_id: "bob" }],
    })).toMatchObject({ state: "review" });
  });

  it("reviews a replacement whose original void was rejected", () => {
    expect(project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
      entries: [entry("set_voids", originalId, "dead")],
    })).toMatchObject({ state: "review" });
  });

  it("never infers synced from an empty queue after ambiguous success", () => {
    expect(project()).toMatchObject({ state: "review" });
  });

  it("tracks a plain void against the exact set UUID", () => {
    expect(project({
      setId: originalId,
      serverSetIds: new Set([originalId]),
      entries: [entry("set_voids", originalId)],
    })).toEqual({ state: "local" });
    expect(project({
      setId: originalId,
      serverSetIds: new Set([originalId]),
      serverVoidIds: new Set([originalId]),
    })).toEqual({ state: "synced" });
  });
});

describe("setQueueHeld", () => {
  it("is true only for a held write of this set", () => {
    expect(setQueueHeld([entry("sets", originalId, "held")], originalId)).toBe(true);
    expect(setQueueHeld([entry("sets", originalId, "waiting")], originalId)).toBe(false);
    expect(setQueueHeld([entry("sets", "someone-else", "held")], originalId)).toBe(false);
    expect(setQueueHeld([], originalId)).toBe(false);
  });

  it("follows a correction to the void of the original", () => {
    const voidHeld = entry("set_voids", originalId, "held");
    expect(setQueueHeld([voidHeld], replacementId, originalId)).toBe(true);
    expect(setQueueHeld([voidHeld], replacementId)).toBe(false);
  });
});

describe("F1: a held void leaves both rows live on the server", () => {
  const links = { [replacementId]: originalId };

  it("names the pair while the correction is still local, and only then", () => {
    expect(correctionWaiting({ state: "local" }, links, replacementId)).toEqual({ originalId });
    expect(correctionWaiting({ state: "synced" }, links, replacementId)).toBeNull();
    expect(correctionWaiting({ state: "review", reason: "x" }, links, replacementId)).toBeNull();
    // an ordinary set is not a correction
    expect(correctionWaiting({ state: "local" }, links, "plain-set")).toBeNull();
  });

  it("says plainly when the replacement landed but its void was refused", () => {
    const receipt = project({
      correctionOf: originalId,
      serverSetIds: new Set([replacementId]),
      entries: [entry("set_voids", originalId, "dead")],
    });
    expect(receipt.state).toBe("review");
    expect(receipt.reason).toContain("Both are live on the server");
  });
});
