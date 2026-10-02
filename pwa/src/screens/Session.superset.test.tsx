// @vitest-environment jsdom
//
// Supersets, member by member, end to end through Session. A round is A1 then
// A2: each member is its own durable write, the NOW member owns the dock, and
// the rest runs once, after the round's last member. Regressions here:
//  H1 a skipped member counts as finished, so the partner is never stranded
//  H3 the in-round gap is not a rest: A2 records rest_seconds_actual null
//     and the next A1 carries the measured rest of the whole round

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import { resetAllSettings } from "../lib/settings";
import type { ActiveSession, ResolvedPrescriptionRow, SetInsert } from "../lib/types";

vi.mock("../lib/data", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    getExercises: vi.fn(async () => ({ data: [] })),
    getLastActuals: vi.fn(async () => ({ data: {} })),
    getServerSessionSets: vi.fn(async () => []),
    getSetNotesByIds: vi.fn(async () => ({})),
    getExactSetReceiptIds: vi.fn(async () => ({ setIds: new Set<string>(), voidIds: new Set<string>() })),
  };
});

vi.mock("../lib/currentUser", () => ({
  getCurrentUserId: () => "aaaaaaaa-1111-4111-8111-111111111111",
  onUserChange: () => () => undefined,
}));

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    enqueueBatch: vi.fn(async () => undefined),
    enqueueCorrection: vi.fn(async () => undefined),
    inspect: vi.fn(async () => []),
    correctionLinks: vi.fn(async () => ({})),
    subscribe: vi.fn(() => () => undefined),
    subscribeSynced: vi.fn(() => () => undefined),
    getStatus: vi.fn(() => ({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null })),
    isStatusKnown: vi.fn(() => true),
  },
}));

import { Session } from "./Session";
import { outbox } from "../lib/sync";
import { getExercises, getLastActuals, getServerSessionSets } from "../lib/data";

const active: ActiveSession = {
  id: "session-superset-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function pair(sets = 2): ResolvedPrescriptionRow[] {
  return [
    { ...rx("bench", "bench-press", "Bench Press", 20, sets), superset_group: 1 },
    { ...rx("row", "barbell-row", "Barbell Row", 20, sets), superset_group: 1, position: 1 },
  ];
}

function rx(
  id: string,
  exerciseId: string,
  name: string,
  loadKg: number | null,
  sets = 3,
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: 0,
    sets,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 90,
    notes: null,
    load_kg: loadKg,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: loadKg,
    plate_load_kg: null,
    superset_group: null,
    tracking: "reps",
  };
}

async function seed(rows: ResolvedPrescriptionRow[], sets: SetInsert[] = []) {
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), rows);
  await cacheSet(cacheKeys.sessionSets(active.id), sets);
  vi.mocked(getServerSessionSets).mockResolvedValue(sets as never);
}

function equipment(...rows: Array<[string, string, string]>) {
  vi.mocked(getExercises).mockResolvedValue({
    data: rows.map(([id, name, eq]) => ({ id, name, equipment: eq })),
  } as never);
}

function renderSession() {
  render(
    <MemoryRouter>
      <Session />
    </MemoryRouter>,
  );
}

function queuedSets(): SetInsert[] {
  return vi
    .mocked(outbox.enqueue)
    .mock.calls.map(([op]) => op)
    .filter((op) => op.kind === "insert" && op.table === "sets")
    .map((op) => (op as { payload: SetInsert }).payload);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  resetAllSettings();
  vi.clearAllMocks();
  vi.mocked(getExercises).mockResolvedValue({ data: [] } as never);
  vi.mocked(getLastActuals).mockResolvedValue({
    data: {},
    fromCache: false,
    stale: null,
  } as never);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueBatch).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueCorrection).mockResolvedValue(undefined);
  vi.mocked(outbox.inspect).mockResolvedValue([]);
  vi.mocked(outbox.correctionLinks).mockResolvedValue({});
  vi.mocked(outbox.subscribe).mockReturnValue(() => undefined);
  vi.mocked(outbox.subscribeSynced).mockReturnValue(() => undefined);
  vi.mocked(outbox.getStatus).mockReturnValue({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null });
  vi.mocked(outbox.isStatusKnown).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  resetAllSettings();
});


const pause = (ms = 260) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function logMember(tag: string, expectedWrites: number) {
  fireEvent.click(await screen.findByRole("button", { name: `Log ${tag}` }));
  await vi.waitFor(() => expect(queuedSets()).toHaveLength(expectedWrites));
  // the duplicate-tap lock holds for 200 ms
  await pause();
}

/** One member's card, whether it is a group (NOW, done, skipped) or a button. */
const card = (tag: string) => {
  const el = [...document.querySelectorAll(".ss-card")].find((node) =>
    node.getAttribute("aria-label")?.startsWith(`${tag} `),
  );
  if (!el) throw new Error(`no ${tag} card`);
  return el as HTMLElement;
};
const chooser = (tag: string) => screen.getByRole("button", { name: new RegExp(`^${tag} .*Log ${tag} next`) });

describe("Session supersets", () => {
  it("shows the round with A1 NOW and A2 NEXT, and no Next exercise while it is unfinished", async () => {
    await seed(pair());
    renderSession();

    expect(await screen.findByRole("heading", { name: "Superset A" })).toBeTruthy();
    expect(screen.getByText("round 1 of 2")).toBeTruthy();
    expect(card("A1").textContent).toContain("● NOW");
    expect(chooser("A2").textContent).toContain("○ NEXT");
    expect(screen.getByRole("button", { name: "Log A1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next exercise/ })).toBeNull();
  });

  it("each member is its own durable write, with no rest between A1 and A2", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");

    await logMember("A1", 1);
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "bench-press", set_index: 0 });
    // A1 is done, A2 is NOW, and the clock has not started
    expect(card("A2").textContent).toContain("● NOW");
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Log A2" })).toBeTruthy();

    await logMember("A2", 2);
    expect(queuedSets()[1]).toMatchObject({ exercise_id: "barbell-row", set_index: 0 });
    // rest comes after the round's last member
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    // said once in the header and once on the dock tag, not a third time (D9)
    expect(screen.queryByText(/Next: Superset A/)).toBeNull();
    expect(screen.getAllByText(/round 2 of 2/i).length).toBe(2);
    expect(queuedSets()[0]!.id).not.toBe(queuedSets()[1]!.id);
  });

  it("D6/D18: the rest after a round keeps the NOW member's picture as LOAD NEXT, tagged A1", async () => {
    equipment(["bench-press", "Bench Press", "barbell"], ["barbell-row", "Barbell Row", "barbell"]);
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");
    await logMember("A1", 1);
    await logMember("A2", 2);
    await screen.findByRole("timer", { name: /^rest timer/ });

    const card = screen.getByText("LOAD NEXT").closest(".focus-load-next") as HTMLElement;
    expect(card.textContent).toContain("A1 · ");
  });

  it("H3: A2 records rest_seconds_actual null and the next A1 carries the round's measured rest", async () => {
    await seed(pair(3));
    renderSession();
    await screen.findByText("round 1 of 3");

    await logMember("A1", 1);
    await logMember("A2", 2);
    await logMember("A1", 3);
    await logMember("A2", 4);
    const [a1r1, a2r1, a1r2, a2r2] = queuedSets();
    expect(a1r1!.rest_seconds_actual).toBeNull();
    expect(a2r1!.rest_seconds_actual).toBeNull();
    expect(typeof a1r2!.rest_seconds_actual).toBe("number");
    expect(a2r2!.rest_seconds_actual).toBeNull();
  });

  it("the rest clock is not reset by the in-round gap", async () => {
    await seed(pair(3));
    renderSession();
    await screen.findByText("round 1 of 3");
    await logMember("A1", 1);
    await logMember("A2", 2);
    await screen.findByRole("timer", { name: /^rest timer/ });
    await logMember("A1", 3);
    // A1 of round 2 ended the rest; A2 follows with no new rest in between
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    expect(card("A2").textContent).toContain("● NOW");
  });

  it("H1: a skipped A2 leaves A1 NOW and loggable, and A1 alone closes the round", async () => {
    await seed(pair());
    await cacheSet(cacheKeys.sessionSkips(active.id), ["row"]);
    renderSession();
    await screen.findByText("round 1 of 2");

    expect(card("A1").textContent).toContain("● NOW");
    expect(card("A2").textContent).toMatch(/SKIPPED/i);
    await logMember("A1", 1);
    // the partner is finished, so A1 closed the round: the rest starts
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unskip" })).toBeNull();
  });

  it("H1: a skipped A1 leaves A2 NOW and loggable", async () => {
    await seed(pair());
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench"]);
    renderSession();
    await screen.findByText("round 1 of 2");

    expect(card("A1").textContent).toMatch(/SKIPPED/i);
    expect(card("A2").textContent).toContain("● NOW");
    await logMember("A2", 1);
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "barbell-row" });
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
  });

  it("tapping the other card makes it NOW; A2 first then A1 rests after A1", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");

    fireEvent.click(chooser("A2"));
    expect(card("A2").textContent).toContain("● NOW");
    await logMember("A2", 1);
    expect(card("A1").textContent).toContain("● NOW");
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    await logMember("A1", 2);
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    // A1 went second this round: its rest is the unknown gap
    expect(queuedSets()[1]!.rest_seconds_actual).toBeNull();
  });

  it("keeps the failed member's draft and does not advance the round", async () => {
    await seed(pair());
    vi.mocked(outbox.enqueue).mockRejectedValueOnce(new Error("disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderSession();
      await screen.findByText("round 1 of 2");
      fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
      fireEvent.click(screen.getByRole("button", { name: "Log A1" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/could not be saved locally.*retry/i);
      expect(card("A1").textContent).toContain("22.5");
      expect(card("A1").textContent).toContain("● NOW");
      expect(screen.getByText("round 1 of 2")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Log A1" })).toBeTruthy();
      expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows Saving... on the Log key while a member's write is in flight, and a second tap does nothing", async () => {
    await seed(pair());
    let release!: () => void;
    vi.mocked(outbox.enqueue).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    renderSession();
    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Log A1" }));
    const saving = await screen.findByRole("button", { name: "Saving…" });
    fireEvent.click(saving);
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull());
  });

  it("keeps each member's staged draft across List and Focus, and across the unit switch", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(chooser("A2"));
    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(card("A1")?.textContent ?? chooser("A1").textContent).toContain("22.5");
    expect(card("A2").textContent).toContain("25");

    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    const dialog = within(screen.getByRole("dialog", { name: "Today's workout" }));
    fireEvent.click(dialog.getByRole("button", { name: "Show weights in pounds" }));
    fireEvent.click(dialog.getByRole("button", { name: "CLOSE" }));
    expect(card("A2").textContent).toContain("55.1");
    expect(chooser("A1").textContent).toContain("49.6");
  });

  it("warns before Home can discard a member's staged draft", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back to Train/ }));

    const dialog = await screen.findByRole("dialog", { name: "Unlogged set changes" });
    expect(dialog.textContent).toMatch(/held only on this screen/i);
    expect(within(dialog).getByRole("button", { name: "Leave and discard drafts" })).toBeTruthy();
  });

  it("does not warn when nothing was edited, even after logging", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");
    await logMember("A1", 1);
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back to Train/ }));
    expect(screen.queryByRole("dialog", { name: "Unlogged set changes" })).toBeNull();
  });

  it("routes the number pad to the NOW member's draft", async () => {
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");

    fireEvent.click(chooser("A2"));
    fireEvent.click(screen.getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "SET LOAD" }));
    expect(card("A2").textContent).toContain("35");
    expect(chooser("A1").textContent).toContain("20 kg");
    await logMember("A2", 1);
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "barbell-row", load_kg: 35 });
  });

  it("shows the NOW member's plates and switches the picture when NOW changes", async () => {
    equipment(["bench-press", "Bench Press", "barbell"], ["barbell-row", "Barbell Row", "barbell"]);
    await seed(pair());
    renderSession();
    await screen.findByText("round 1 of 2");
    expect(screen.getByRole("button", { name: /^A1 · .*Open plates/ })).toBeTruthy();
    await logMember("A1", 1);
    expect(screen.getByRole("button", { name: /^A2 · .*Open plates/ })).toBeTruthy();
  });

  it("goes on to the next exercise after the final round, with no trailing rest", async () => {
    await seed([...pair(1), { ...rx("curl", "cable-curl", "Cable Curl", 20, 1), position: 2 }]);
    renderSession();
    await screen.findByText("round 1 of 1");
    await logMember("A1", 1);
    await logMember("A2", 2);
    expect(await screen.findByRole("heading", { name: "Cable Curl" })).toBeTruthy();
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
  });

  it("opens a three-member circuit in List and says why paired Focus is unavailable", async () => {
    await seed([
      ...pair(),
      { ...rx("curl", "cable-curl", "Cable Curl", 20, 2), superset_group: 1, position: 2 },
    ]);
    renderSession();
    expect(await screen.findByText("This workout opens in List because Superset A has 3 exercises.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Superset A" })).toBeNull();
  });

  it("UI-14: a three-member circuit rests after the round, not after each station", async () => {
    await seed([
      ...pair(),
      { ...rx("curl", "cable-curl", "Cable Curl", 20, 2), superset_group: 1, position: 2 },
    ]);
    renderSession();
    await screen.findByText("This workout opens in List because Superset A has 3 exercises.");
    const logOpen = async (name: string | null, n: number) => {
      if (name) fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name} —`) }));
      fireEvent.click(await screen.findByRole("button", { name: "LOG SET" }));
      await vi.waitFor(() => expect(queuedSets()).toHaveLength(n));
      await new Promise((r) => setTimeout(r, 450));
    };
    await logOpen(null, 1);
    // station 1 of 3: nobody has finished the round, so no rest strip
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    await logOpen("Barbell Row", 2);
    expect(screen.queryByRole("timer", { name: /^rest timer/ })).toBeNull();
    // the stations after the first record no rest (the gap is not a rest)
    expect(queuedSets()[1]!.rest_seconds_actual ?? null).toBeNull();
    await logOpen("Cable Curl", 3);
    // the round closes on the last station
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
  });

  it("finishes an unequal tail with the remaining member only", async () => {
    await seed([
      { ...rx("bench", "bench-press", "Bench Press", 20, 2), superset_group: 1 },
      { ...rx("row", "barbell-row", "Barbell Row", 20, 1), superset_group: 1, position: 1 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Superset A" });
    await logMember("A1", 1);
    await logMember("A2", 2);
    // the round's rest runs; only A1 has a round left, so it is the only Log
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log A1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log A2" })).toBeNull();
    await logMember("A1", 3);
    expect(queuedSets()[2]).toMatchObject({ exercise_id: "bench-press", set_index: 1 });
  });

  it("un-skips a member from its card, and logging it counts again", async () => {
    await seed(pair());
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench"]);
    renderSession();
    await screen.findByText("round 1 of 2");
    expect(card("A1").textContent).toMatch(/SKIPPED/i);
    fireEvent.click(screen.getByRole("button", { name: "Unskip A1" }));
    expect(card("A1").textContent).not.toMatch(/SKIPPED/i);
    await logMember("A1", 1);
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "bench-press" });
  });

  it("flips a warmup member to working after logging it", async () => {
    await seed([
      { ...rx("bench-w", "bench-press", "Bench Press", 20, 1), superset_group: 1, set_type: "warmup", position: 0 },
      { ...rx("bench", "bench-press", "Bench Press", 20, 1), superset_group: 1, set_type: "working", position: 1 },
      { ...rx("row", "barbell-row", "Barbell Row", 20, 1), superset_group: 1, position: 2 },
    ]);
    renderSession();
    await screen.findByText("round 1 of 1");
    // stage A1 on its outstanding warmup explicitly: the first-open prefill
    // lands a render after mount and this test is about what happens after
    fireEvent.click(screen.getByRole("button", { name: "more options for Bench Press" }));
    const a1More = await screen.findByRole("group", { name: "A1 Bench Press · more" });
    fireEvent.click(within(a1More).getByRole("button", { name: "warmup" }));
    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));
    await logMember("A1", 1);
    expect(queuedSets()[0]).toMatchObject({ exercise_id: "bench-press", set_type: "warmup" });
    // warmups advance by working progress (documented limitation): the
    // warmup is followed by its rest, and A1 is still NOW with a working set
    expect(await screen.findByRole("timer", { name: /^rest timer/ })).toBeTruthy();
    await logMember("A1", 2);
    expect(queuedSets()[1]).toMatchObject({ exercise_id: "bench-press", set_type: "working" });
  });
});
