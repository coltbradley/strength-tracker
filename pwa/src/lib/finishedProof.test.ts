import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetInsert } from "./types";

const h = vi.hoisted(() => ({
  cached: [] as unknown[],
  entries: [] as unknown[],
  links: {} as Record<string, string>,
  exact: { setIds: new Set<string>(), voidIds: new Set<string>() },
  fail: false,
}));

vi.mock("./db", () => ({
  cacheGet: async () => h.cached,
  cacheKeys: { sessionSets: (id: string) => `sessionSets:${id}` },
}));
vi.mock("./data", () => ({
  getExactSetReceiptIds: async () => {
    if (h.fail) throw new Error("offline");
    return h.exact;
  },
}));
vi.mock("./sync", () => ({
  outbox: {
    inspect: async () => h.entries,
    correctionLinks: async () => h.links,
  },
}));
vi.mock("./errors", () => ({ reportError: () => undefined }));

import { proofForSession, readFinishedSessionProof } from "./finishedProof";

const set = (id: string): SetInsert =>
  ({ id, session_id: "s1", exercise_id: "x", set_index: 0, set_type: "working", load_kg: 50, reps: 5 }) as SetInsert;

beforeEach(() => {
  h.cached = [set("a"), set("b")];
  h.entries = [];
  h.links = {};
  h.exact = { setIds: new Set(["a", "b"]), voidIds: new Set() };
  h.fail = false;
});

describe("readFinishedSessionProof", () => {
  it("confirms only sets the server returned by exact UUID", async () => {
    expect(await readFinishedSessionProof("s1", "u")).toEqual({ sets: 2, confirmed: 2, unconfirmed: 0 });
    h.exact = { setIds: new Set(["a"]), voidIds: new Set() };
    h.cached = [set("a"), set("b")];
    // b is neither on the server nor queued: not confirmed
    expect(await readFinishedSessionProof("s1", "u")).toEqual({ sets: 2, confirmed: 1, unconfirmed: 1 });
  });

  it("counts a correction once: the replacement, with the original voided", async () => {
    h.cached = [set("a"), set("a2")];
    h.links = { a2: "a" };
    h.exact = { setIds: new Set(["a2"]), voidIds: new Set(["a"]) };
    expect(await readFinishedSessionProof("s1", "u")).toEqual({ sets: 1, confirmed: 1, unconfirmed: 0 });
  });

  it("says nothing when the read fails or the phone holds no sets", async () => {
    h.fail = true;
    expect(await readFinishedSessionProof("s1", "u")).toBeNull();
    h.fail = false;
    h.cached = [];
    expect(await readFinishedSessionProof("s1", "u")).toBeNull();
  });
});

describe("proofForSession (F-7)", () => {
  const proof = { sets: 6, confirmed: 6, unconfirmed: 0 };

  it("shows a proof only for the session it was read for", () => {
    const held = { sessionId: "first", proof };
    expect(proofForSession(held, "first")).toBe(proof);
    // a second finished session the same day must not borrow the first's proof
    expect(proofForSession(held, "second")).toBeNull();
    expect(proofForSession(held, null)).toBeNull();
    expect(proofForSession(null, "first")).toBeNull();
  });

  it("a proof that failed to read stays null for its own session", () => {
    expect(proofForSession({ sessionId: "first", proof: null }, "first")).toBeNull();
  });
});
