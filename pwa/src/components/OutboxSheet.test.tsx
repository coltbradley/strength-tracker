// @vitest-environment jsdom
//
// The queue's whole job on screen is to be honest twice over: honest that a
// set has not landed, and honest about which of the parked ones an action can
// actually help. So the two things worth pinning are the counts and the
// promises — a "Retry" that cannot work is worse than no retry at all, and a
// couple of writes syncing on gym wifi must not be dressed as a failure.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { OutboxSheet, describeOp, formatAge } from "./OutboxSheet";
import type { OutboxEntry } from "../lib/outbox";

const h = vi.hoisted(() => ({
  status: {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle" as const,
    lastError: null,
  },
  entries: [] as OutboxEntry[],
  retryDead: vi.fn(async () => ({ requeued: 0, stuck: 0 })),
  buildQueueExport: vi.fn(() => ({ items: [] })),
  downloadText: vi.fn(),
}));

vi.mock("../lib/sync", () => ({
  outbox: {
    // one stable object, so useSyncExternalStore does not loop
    getStatus: () => h.status,
    subscribe: () => () => {},
    inspect: () => Promise.resolve(h.entries),
    retryDead: h.retryDead,
  },
}));

vi.mock("../lib/data", () => ({
  getExercises: () =>
    Promise.resolve({
      data: [
        { id: "Barbell_Squat", name: "Barbell Squat", equipment: "barbell" },
      ],
      fromCache: false,
    }),
}));

vi.mock("../lib/export", () => ({
  buildQueueExport: h.buildQueueExport,
  downloadText: h.downloadText,
  exportFilename: () => "strength-log-unsynced-20260904.json",
}));


const AGES_AGO = new Date(Date.now() - 8 * 60_000).toISOString();

function entry(over: Partial<OutboxEntry> & { key: number }): OutboxEntry {
  return {
    op: {
      kind: "insert",
      table: "sets",
      payload: {
        id: `set-${over.key}`,
        session_id: "sess",
        exercise_id: "Barbell_Squat",
        prescription_id: null,
        set_index: 0,
        set_type: "working",
        load_kg: 100,
        reps: 5,
        performed_at: AGES_AGO,
        rest_seconds_actual: null,
      },
    },
    table: "sets",
    created_at: AGES_AGO,
    retries: 0,
    last_error: null,
    user_id: undefined,
    state: "waiting",
    cause: null,
    retryable: false,
    ...over,
  };
}

/** Set the queue the sheet will read, then render it and wait for the read. */
async function show(entries: OutboxEntry[]) {
  h.entries = entries;
  h.status = {
    ...h.status,
    pending: entries.filter((e) => e.state !== "dead").length,
    held: entries.filter((e) => e.state === "held").length,
    dead: entries.filter((e) => e.state === "dead").length,
  };
  render(<OutboxSheet onClose={() => undefined} />);
  await screen.findByText("Waiting to sync");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("formatAge", () => {
  it("does not dress up a fresh queue", () => {
    expect(formatAge(0)).toBe("JUST NOW");
    expect(formatAge(59_000)).toBe("JUST NOW");
  });

  it("changes unit rather than counting past one", () => {
    expect(formatAge(8 * 60_000)).toBe("8 MIN");
    expect(formatAge(59 * 60_000)).toBe("59 MIN");
    expect(formatAge(90 * 60_000)).toBe("1H");
    expect(formatAge(50 * 3_600_000)).toBe("2D");
  });
});

describe("describeOp", () => {
  it("says what the write is, in the app's own words", () => {
    const names = { Barbell_Squat: "Barbell Squat" };
    expect(describeOp(entry({ key: 1 }).op, names)).toBe("Set · Barbell Squat");
    // an id nobody has a name for still reads as something
    expect(describeOp(entry({ key: 1 }).op, {})).toBe("Set logged");
  });

  it("tells an ended session from a discarded one", () => {
    const ended = describeOp(
      {
        kind: "update",
        table: "sessions",
        id: "s",
        patch: {
          ended_at: "2026-09-01T10:00:00.000Z",
          session_rpe: null,
          bodyweight_kg: null,
          notes: null,
        },
      },
      {},
    );
    const gone = describeOp(
      {
        kind: "update",
        table: "sessions",
        id: "s",
        patch: { discarded_at: "2026-09-01T10:00:00.000Z" },
      },
      {},
    );
    expect(ended).toBe("Session ended");
    expect(gone).toBe("Session discarded");
  });
});

describe("OutboxSheet", () => {
  it("reads as a queue doing its job when nothing is stuck", async () => {
    await show([entry({ key: 1 }), entry({ key: 2 })]);

    expect(screen.getByText("Waiting to sync").nextSibling).toHaveProperty(
      "textContent",
      "2",
    );
    // No alarm where there is none: the two rows that mean something is
    // parked are absent entirely.
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByText("Held for another account")).toBeNull();
    expect(screen.getByText(/normal state offline/)).toBeTruthy();
    expect(screen.getByText("Oldest").nextSibling).toHaveProperty(
      "textContent",
      "8 MIN",
    );
  });

  it("counts waiting, held and failed apart and says why each is parked", async () => {
    await show([
      entry({ key: 1 }),
      entry({ key: 2, state: "held", user_id: "someone-else" }),
      entry({
        key: 3,
        state: "dead",
        cause: "rejected",
        retryable: false,
        last_error: 'violates check constraint "sets_reps_check"',
      }),
    ]);

    expect(screen.getByText("Waiting to sync").nextSibling).toHaveProperty(
      "textContent",
      "1",
    );
    expect(
      screen.getByText("Held for another account").nextSibling,
    ).toHaveProperty("textContent", "1");
    expect(screen.getByText("Failed").nextSibling).toHaveProperty(
      "textContent",
      "1",
    );

    // The reason a held item is held is the invariant, not an apology.
    expect(screen.getByText(/cannot be reassigned once it lands/)).toBeTruthy();
    expect(screen.getByText(/rejected the row itself/)).toBeTruthy();
    // The server's own words survive to the screen.
    expect(screen.getByText(/sets_reps_check/)).toBeTruthy();
  });

  it("offers a retry only for the failures whose answer can change", async () => {
    await show([
      entry({ key: 1, state: "dead", cause: "blocked", retryable: true }),
      entry({ key: 2, state: "dead", cause: "rejected", retryable: false }),
    ]);

    const button = screen.getByRole("button", { name: "Retry 1 failed" });
    expect(button).toHaveProperty("disabled", false);
    // ...and it says so, rather than quietly doing half of what it offered.
    expect(screen.getByText(/would be refused again unchanged/)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(h.retryDead).toHaveBeenCalledTimes(1));
  });

  it("offers no retry at all when nothing could succeed", async () => {
    await show([
      entry({ key: 1, state: "dead", cause: "rejected", retryable: false }),
      entry({ key: 2, state: "held", user_id: "someone-else" }),
    ]);

    // A held item is pending and healthy; retry is a verb aimed at dead ones,
    // and replaying someone else's set as the current user is the one thing
    // an append-only table can never take back.
    const button = screen.getByRole("button", { name: "Nothing to retry" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(h.retryDead).not.toHaveBeenCalled();
  });

  it("exports every queued write, held and failed ones included", async () => {
    const entries = [
      entry({ key: 1 }),
      entry({ key: 2, state: "held", user_id: "someone-else" }),
      entry({ key: 3, state: "dead", cause: "rejected", retryable: false }),
    ];
    await show(entries);

    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(h.downloadText).toHaveBeenCalledTimes(1));

    expect(h.buildQueueExport).toHaveBeenCalledWith(
      entries,
      { Barbell_Squat: "Barbell Squat" },
      expect.any(String),
    );
    expect(h.downloadText.mock.calls[0][0]).toBe(
      "strength-log-unsynced-20260904.json",
    );
  });

  it("has nothing to export when the queue is empty", async () => {
    await show([]);
    expect(
      screen.getByText(/Everything you have logged is on the server/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export queue/ })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
