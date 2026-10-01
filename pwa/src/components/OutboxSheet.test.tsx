// @vitest-environment jsdom
//
// The queue's whole job on screen is to be honest twice over: honest that a
// set has not landed, and honest about which of the parked ones an action can
// actually help. So the two things worth pinning are the counts and the
// promises — a "Retry" that cannot work is worse than no retry at all, and a
// couple of writes syncing on gym wifi must not be dressed as a failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  repairDeadLoadSet: vi.fn(async () => true),
  repairDeadLoadSets: vi.fn(async () => true),
  buildQueueExport: vi.fn(() => ({ items: [] })),
  downloadText: vi.fn(),
  unit: "kg" as "kg" | "lb",
  known: true,
  online: true,
}));

vi.mock("../hooks/useFabDrag", () => ({ useOnline: () => h.online }));

vi.mock("../hooks/useUnit", () => ({ useUnit: () => h.unit }));

vi.mock("../lib/sync", () => ({
  outbox: {
    // one stable object, so useSyncExternalStore does not loop
    getStatus: () => h.status,
    isStatusKnown: () => h.known,
    subscribe: () => () => {},
    inspect: () => Promise.resolve(h.entries),
    retryDead: h.retryDead,
    repairDeadLoadSet: h.repairDeadLoadSet,
    repairDeadLoadSets: h.repairDeadLoadSets,
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
  h.unit = "kg";
  h.known = true;
  h.online = true;
  Reflect.deleteProperty(navigator, "canShare");
  Reflect.deleteProperty(navigator, "share");
});

describe("D2: the sheet is reachable from the chip in every state", () => {
  beforeEach(() => {
    h.status = { pending: 0, dead: 0, held: 0, state: "idle", lastError: null };
  });

  it("says everything is on the server, with the last-synced time when it is known", async () => {
    const at = new Date(2026, 9, 1, 15, 42).getTime();
    h.status = { ...h.status, pending: 0, dead: 0, lastSyncedAt: at } as typeof h.status;
    render(<OutboxSheet onClose={() => undefined} />);
    expect(await screen.findByRole("dialog", { name: "All on the server" })).toBeTruthy();
    expect(screen.getByText(/Everything you have logged is on the server/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Last write reached the server at/);
    h.status = { ...h.status, lastSyncedAt: undefined } as typeof h.status;
  });

  it("does not invent a last-synced time it does not have", async () => {
    render(<OutboxSheet onClose={() => undefined} />);
    await screen.findByRole("dialog", { name: "All on the server" });
    expect(screen.queryByText(/Last write/)).toBeNull();
  });

  it("is titled Not yet on the server while writes wait, and says offline is normal", async () => {
    h.online = false;
    await show([entry({ key: 1 })]);
    expect(screen.getByRole("dialog", { name: "Not yet on the server" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Offline/);
  });

  it("claims nothing while the queue has not been read", async () => {
    h.known = false;
    h.status = { ...h.status, pending: 0, dead: 0, held: 0 };
    render(<OutboxSheet onClose={() => undefined} />);
    expect(await screen.findByRole("dialog", { name: "Checking the queue" })).toBeTruthy();
    expect(screen.queryByText(/Everything you have logged is on the server/)).toBeNull();
  });
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
    expect(
      describeOp(
        {
          kind: "update",
          table: "sessions",
          id: "s",
          patch: { discarded_at: "2026-09-01T10:00:00.000Z" },
        },
        {},
        "dead",
      ),
    ).toBe("Discard refused");
  });
});

describe("OutboxSheet", () => {
  it("distinguishes correction pairs with the same exercise, set index and time", async () => {
    const first = entry({ key: 1, state: "dead", cause: "rejected", loadRepairable: true });
    const second = entry({ key: 2, state: "dead", cause: "rejected", loadRepairable: true });
    await show([first, second]);

    expect(screen.getByText(/ID set-1/)).toBeTruthy();
    expect(screen.getByText(/ID set-2/)).toBeTruthy();
  });
  it("reviews a 65.77 kg total as 145 lb without treating stale entered kg as authored truth", async () => {
    h.unit = "lb";
    const original = {
      ...(entry({ key: 7 }).op as Extract<OutboxEntry["op"], { kind: "insert"; table: "sets" }>).payload,
      load_kg: 65.77,
      load_entry: "total" as const,
      entered_load: 65.8,
      entered_unit: "kg" as const,
    };
    await show([entry({
      key: 7,
      op: { kind: "insert", table: "sets", payload: original },
      state: "dead",
      cause: "rejected",
      loadRepairable: true,
      last_error: "load_kg must match entered_load, entered_unit, and load_entry",
    })]);

    fireEvent.click(screen.getByRole("button", { name: /Review 1 of 1/ }));
    expect(screen.getByText("Logged total: 65.77 kg")).toBeTruthy();
    expect(screen.getByText("In your unit: 145 lb total")).toBeTruthy();
    expect(screen.getByText(/Rejected row's entered fields: 65.8 kg/)).toBeTruthy();
    expect(screen.getByText(/may be stale/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep 145 lb total and retry" })).toHaveProperty("disabled", true);
  });

  it("shows the per-side equivalent while the repair button names the stored total", async () => {
    h.unit = "lb";
    const original = {
      ...(entry({ key: 8 }).op as Extract<OutboxEntry["op"], { kind: "insert"; table: "sets" }>).payload,
      load_kg: 65.77,
      load_entry: "per_side" as const,
      entered_load: 65.8,
      entered_unit: "kg" as const,
    };
    await show([entry({
      key: 8,
      op: { kind: "insert", table: "sets", payload: original },
      state: "dead",
      cause: "rejected",
      loadRepairable: true,
    })]);
    fireEvent.click(screen.getByRole("button", { name: /Review 1 of 1/ }));
    expect(screen.getByText("In your unit: 145 lb total")).toBeTruthy();
    expect(screen.getByText("Per side: 72.5 lb/side")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep 145 lb total and retry" })).toBeTruthy();
  });
  it("requires a saved export and review before retrying an authored-load failure", async () => {
    const original = {
      ...(entry({ key: 1 }).op as Extract<OutboxEntry["op"], { kind: "insert"; table: "sets" }>).payload,
      load_entry: "total" as const,
      entered_load: 220.5,
      entered_unit: "lb" as const,
    };
    await show([entry({
      key: 1,
      op: { kind: "insert", table: "sets", payload: original },
      state: "dead",
      cause: "rejected",
      retryable: false,
      loadRepairable: true,
      last_error: "load_kg must match entered_load, entered_unit, and load_entry",
      user_id: "alice",
    })]);

    fireEvent.click(screen.getByRole("button", { name: /Review 1 of 1/ }));
    expect(screen.getByText(/220.5 lb/)).toBeTruthy();
    expect(screen.getByText("Logged total: 100 kg")).toBeTruthy();
    const repair = screen.getByRole("button", { name: /Keep 100 kg total and retry/ });
    expect(repair).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(h.downloadText).toHaveBeenCalledTimes(1));
    expect(repair).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /saved the queue export/ }));
    expect(repair).toHaveProperty("disabled", false);
    fireEvent.click(repair);
    await waitFor(() => expect(h.repairDeadLoadSet).toHaveBeenCalledWith(1, original));
  });

  it("reviews seven totals, then repairs them with one saved export and confirmation", async () => {
    const rows = [65.77, 34.02, 45.36, 52.16, 65.77, 34.02, 45.36].map((load, i) =>
      entry({
        key: i + 1, state: "dead", cause: "rejected", loadRepairable: true,
        user_id: "alice",
        op: { kind: "insert", table: "sets", payload: {
          ...(entry({ key: i + 1 }).op as Extract<OutboxEntry["op"], { kind: "insert"; table: "sets" }>).payload,
          set_index: i, load_kg: load, entered_load: Math.round(load * 10) / 10,
          entered_unit: "kg", load_entry: "total",
        } },
      }));
    await show(rows);
    expect(screen.getByText("REVIEW ALL 7 SETS")).toBeTruthy();
    expect(screen.getByText(/set 1: 65.77 kg total/)).toBeTruthy();
    expect(screen.getByText(/set 7: 45.36 kg total/)).toBeTruthy();
    const action = screen.getByRole("button", { name: "Repair all 7 sets and retry" });
    expect(action).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(h.downloadText).toHaveBeenCalledTimes(1));
    expect(action).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /checked all 7 totals/ }));
    fireEvent.click(action);
    await waitFor(() => expect(h.repairDeadLoadSets).toHaveBeenCalledTimes(1));
    expect(h.repairDeadLoadSets).toHaveBeenCalledWith(rows);
    expect(h.repairDeadLoadSet).not.toHaveBeenCalled();
  });

  it("keeps batch repair locked after a cancelled phone export", async () => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true,
      value: () => Promise.reject(new DOMException("Cancelled", "AbortError")) });
    await show([1, 2].map((key) => entry({ key, state: "dead", cause: "rejected", loadRepairable: true })));
    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Export queue/ })).toHaveProperty("disabled", false));
    expect(screen.getByRole("button", { name: "Repair all 2 sets and retry" })).toHaveProperty("disabled", true);
    expect(h.repairDeadLoadSets).not.toHaveBeenCalled();
  });

  it("does not offer load repair for a generic check violation", async () => {
    await show([entry({
      key: 2,
      state: "dead",
      cause: "rejected",
      retryable: false,
      loadRepairable: false,
      last_error: 'violates check constraint "sets_reps_check"',
    })]);
    expect(screen.queryByRole("button", { name: /Review \d+ of/ })).toBeNull();
  });

  it("uses the native file share on a phone and waits for a saved-copy acknowledgement", async () => {
    let finishShare: (() => void) | undefined;
    const share = vi.fn((_data: ShareData) => new Promise<void>((resolve) => { finishShare = resolve; }));
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await show([entry({ key: 1, state: "dead", cause: "rejected", loadRepairable: true })]);

    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files?.[0]?.name).toBe("strength-log-unsynced-20260904.json");
    expect(h.downloadText).not.toHaveBeenCalled();
    finishShare?.();
    await waitFor(() => expect(screen.getByRole("button", { name: /Export queue/ })).toHaveProperty("disabled", false));
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });

  it("keeps repair locked when the native file share is cancelled", async () => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Cancelled", "AbortError")),
    });
    await show([entry({
      key: 1,
      state: "dead",
      cause: "rejected",
      retryable: false,
      loadRepairable: true,
      last_error: "load_kg must match entered_load, entered_unit, and load_entry",
    })]);
    fireEvent.click(screen.getByRole("button", { name: /Review 1 of 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Export queue/ })).toHaveProperty("disabled", false));
    expect(screen.getByRole("checkbox", { name: /saved the queue export/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Keep 100 kg total and retry/ })).toHaveProperty("disabled", true);
  });

  it("explains when to retry refused removals and notes linked to failed sets", async () => {
    await show([
      entry({ key: 1, state: "dead", cause: "rejected", loadRepairable: true }),
      entry({
        key: 2,
        op: { kind: "insert", table: "set_voids", payload: { set_id: "set-1" } },
        table: "set_voids",
        state: "dead",
        cause: "blocked",
        retryable: true,
      }),
      entry({
        key: 3,
        op: { kind: "insert", table: "set_notes", payload: { set_id: "set-1", note: "Shoulder felt tight" } },
        table: "set_notes",
        state: "dead",
        cause: "blocked",
        retryable: true,
      }),
    ]);

    expect(screen.getByText(/After the set syncs, use Retry failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nothing to retry" })).toHaveProperty("disabled", true);
  });

  it("uses the download path when file sharing cannot inspect a JSON file", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => { throw new TypeError("unsupported file"); },
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn() });
    await show([entry({ key: 1 })]);
    fireEvent.click(screen.getByRole("button", { name: /Export queue/ }));
    await waitFor(() => expect(h.downloadText).toHaveBeenCalledTimes(1));
  });
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

  it("counts another account's held writes without showing what they are (A-148)", async () => {
    await show([entry({ key: 2, state: "held", user_id: "someone-else" })]);

    expect(
      screen.getByText("Held for another account").nextSibling,
    ).toHaveProperty("textContent", "1");
    // A shared phone must not show one person another person's training.
    expect(screen.queryByText(/Barbell Squat/)).toBeNull();
    expect(screen.queryByText(/100/)).toBeNull();
  });

  it("offers a retry only for the failures whose answer can change", async () => {
    await show([
      entry({ key: 1, state: "dead", cause: "blocked", retryable: true }),
      entry({ key: 2, state: "dead", cause: "rejected", retryable: false }),
    ]);

    const button = screen.getByRole("button", { name: "Retry 1 failed" });
    expect(button).toHaveProperty("disabled", false);
    // ...and it says so, rather than quietly doing half of what it offered.
    expect(screen.getByText(/rejected rows need repair/i)).toBeTruthy();

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

  it("exports the queue, passing held rows to the builder that redacts them", async () => {
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
