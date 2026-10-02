import { describe, expect, it } from "vitest";
import { discardOutcome } from "./discardOutcome";

const discard = (id: string, state: "waiting" | "held" | "dead") => ({
  op: {
    kind: "update",
    table: "sessions",
    id,
    patch: { discarded_at: "2026-10-01T10:00:00Z" },
  },
  state,
});

describe("UI-18: discardOutcome", () => {
  it("is applied once the discard has left the queue", () => {
    expect(discardOutcome([], "s1")).toBe("applied");
  });

  it("is queued while the write is still waiting or held", () => {
    expect(discardOutcome([discard("s1", "waiting")], "s1")).toBe("queued");
    expect(discardOutcome([discard("s1", "held")], "s1")).toBe("queued");
  });

  it("is refused when the server rejected it", () => {
    expect(discardOutcome([discard("s1", "dead")], "s1")).toBe("refused");
  });

  it("looks only at this session's discard", () => {
    expect(discardOutcome([discard("s2", "dead")], "s1")).toBe("applied");
    // an ended_at patch is not a discard
    expect(
      discardOutcome(
        [
          {
            op: {
              kind: "update",
              table: "sessions",
              id: "s1",
              patch: { ended_at: "x" },
            },
            state: "dead",
          },
        ],
        "s1",
      ),
    ).toBe("applied");
  });
});
