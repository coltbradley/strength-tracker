// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { cacheGet, cacheKeys, cacheSet, resetDbForTests } from "../lib/db";
import type {
  ActiveSession,
  ResolvedPrescriptionRow,
  SetInsert,
} from "../lib/types";

vi.mock("../lib/data", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    getExercises: vi.fn(async () => ({ data: [] })),
    getLastActuals: vi.fn(async () => ({ data: {} })),
    getServerSessionSets: vi.fn(async () => []),
    getSetNotesByIds: vi.fn(async () => ({})),
  };
});

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
  },
}));

import { outbox } from "../lib/sync";
import { getServerSessionSets } from "../lib/data";
import { Session } from "./Session";

afterEach(cleanup);

const active: ActiveSession = {
  id: "session-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

function prescription(
  id: string,
  exerciseId: string,
  name: string,
  loadKg: number,
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: id === "bench" ? 0 : 1,
    sets: 1,
    reps_min: id === "bench" ? 8 : 5,
    reps_max: id === "bench" ? 8 : 5,
    rest_seconds: 60,
    notes: null,
    load_kg: loadKg,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: loadKg,
    plate_load_kg: null,
    superset_group: null,
  };
}

const bench = prescription("bench", "bench-press", "Bench Press", 20);
const squat = prescription("squat", "back-squat", "Back Squat", 100);
const benchSet: SetInsert = {
  id: "bench-set-1",
  session_id: active.id,
  exercise_id: bench.exercise_id,
  prescription_id: bench.id,
  set_index: 0,
  set_type: "working",
  load_kg: 20,
  reps: 8,
  performed_at: "2026-09-12T12:05:00.000Z",
  rest_seconds_actual: null,
  load_entry: "total",
  rpe: null,
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  vi.mocked(getServerSessionSets).mockResolvedValue([benchSet]);
  await cacheSet(cacheKeys.activeSession, active);
  await cacheSet(cacheKeys.sessionRx(active.id), [bench, squat]);
  await cacheSet(cacheKeys.sessionSets(active.id), [benchSet]);
});

describe("Session corrections", () => {
  it("keeps a staged correction on its source entry when another Detail is requested", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // This scenario is eligible for focus, which is now the default on
    // start — go to the workout overview first, since "expand details" is
    // the accordion's own control.
    fireEvent.click(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "expand details" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Correct logged set 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));

    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "expand details" }));

    expect(screen.getByText("TARGET 1×8 @ 20 KG · REST 1:00")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");
    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe("Session log lock", () => {
  it("logs one set for a double LOG tap and flashes .is-held without a second insert", async () => {
    resetDbForTests();
    const squat2 = {
      ...prescription("squat", "back-squat", "Back Squat", 100),
      sets: 2,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat2]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    // The reps stepper initializes from the fallback setting (8) before the
    // async prefill effect syncs it to this prescription's target (5); wait
    // for that to settle before tapping LOG, matching the established
    // pattern in Session.focus.test.tsx's "no hidden bar fallback" test.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    fireEvent.click(log);

    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /log set/i }).className,
    ).toContain("is-held");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 130));
    });
    expect(
      screen.getByRole("button", { name: /log set/i }).className,
    ).not.toContain("is-held");
  });

  it("applies a correction started right after a log, before the 200 ms lock clears", async () => {
    resetDbForTests();
    const squat1 = prescription("squat", "back-squat", "Back Squat", 100);
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat1]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    // See the log-lock test above: wait for the prefill effect to settle
    // reps at the prescription's target before logging, or a flaky race
    // with the fallback default (8) makes this set's reps unpredictable.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    // No wait here — the 200 ms log lock from the tap above is still
    // engaged. A correction must go through anyway (Decision 6).
    fireEvent.click(
      screen.getByRole("button", { name: "more options for Back Squat" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Correct logged set 1" }),
    );
    // No jest-dom in this project (see CheckInSheet.render.test.tsx) -- read
    // the DOM state toBeDisabled() would, without adding a dependency.
    const saveButton = screen.getByRole("button", {
      name: "SAVE SET 1",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(saveButton);

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(3),
    );
    expect(vi.mocked(outbox.enqueue).mock.calls[1]?.[0]).toMatchObject({
      kind: "insert",
      table: "sets",
      payload: { reps: 6 },
    });
    expect(vi.mocked(outbox.enqueue).mock.calls[2]?.[0]).toMatchObject({
      kind: "insert",
      table: "set_voids",
    });
  });

  it("keeps stepper and pad edits live while the log lock is engaged", async () => {
    resetDbForTests();
    const squat2 = {
      ...prescription("squat", "back-squat", "Back Squat", 100),
      sets: 2,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat2]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "increase load by 2.5 kg" }),
    );
    expect(
      screen.getByRole("button", { name: "load value — tap to type" })
        .textContent,
    ).toBe("102.5");

    fireEvent.click(
      screen.getByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    // Neither edit was a LOG tap, so the lock never engaged twice.
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
  });

  it("offers How to in the more sheet, opening the same exercise demo sheet the overview uses", async () => {
    resetDbForTests();
    const squat1 = prescription("squat", "back-squat", "Back Squat", 100);
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat1]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("button", { name: /log set/i });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(log);

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Back Squat" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /how to/i }));

    // ExerciseDemoSheet renders a heading/title using the exercise's own
    // name — assert that it now shows that heading instead of the more sheet.
    // The more sheet is now closed but still in the DOM. The demo sheet renders
    // on top as a modal.
    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: /back squat/i }),
      ).toBeTruthy();
    });
  });
});

describe("Session hero capture", () => {
  it("shows the warmup/working toggle on the hero for an entry with a warmup bracket, and Already warm stages working without logging", async () => {
    resetDbForTests();
    const warmup: ResolvedPrescriptionRow = {
      ...prescription("squat-warmup", "back-squat", "Back Squat", 40),
      sets: 1,
      set_type: "warmup",
      position: 0,
    };
    const working: ResolvedPrescriptionRow = {
      ...prescription("squat-working", "back-squat", "Back Squat", 100),
      sets: 1,
      set_type: "working",
      position: 1,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [warmup, working]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Back Squat" });
    // The prefill effect that decides the opening set type (the plan's
    // outstanding warmup) settles asynchronously — see the log-lock tests'
    // stabilization note in the "Session log lock" describe block above.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("button", { name: "warmup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "working" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Already warm" }));
    expect(vi.mocked(outbox.enqueue)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "working" }).className).toMatch(
      /seg-on/,
    );
  });

  it("shows the last logged set as a tappable line that opens its correction", async () => {
    resetDbForTests();
    const loggedSquat: SetInsert = {
      id: "squat-set-1",
      session_id: active.id,
      exercise_id: "back-squat",
      prescription_id: "squat",
      set_index: 0,
      set_type: "working",
      load_kg: 145,
      reps: 5,
      performed_at: "2026-09-12T12:05:00.000Z",
      rest_seconds_actual: null,
      load_entry: "total",
      rpe: null,
    };
    const squat2 = {
      ...prescription("squat", "back-squat", "Back Squat", 145),
      sets: 2,
    };
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [squat2]);
    await cacheSet(cacheKeys.sessionSets(active.id), [loggedSquat]);
    vi.mocked(getServerSessionSets).mockResolvedValue([loggedSquat]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    const lastSet = await screen.findByRole("button", {
      name: "Last: 145 kg × 5 working",
    });
    fireEvent.click(lastSet);

    expect(screen.getByRole("button", { name: "SAVE SET 1" })).toBeTruthy();
  });

  it("offers Swap exercise as a visible hero action", async () => {
    // The default fixture's bench prescription is already met by `benchSet`
    // (see beforeEach), which sends focus straight past it to Back Squat —
    // a lone, unstarted bench entry is what actually opens Bench Press.
    resetDbForTests();
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [bench]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "Swap exercise" }));

    // The swap sheet is the same ExercisePicker every other picker in this
    // screen uses (title "SWAP EXERCISE"); its search field is what confirms
    // it actually opened.
    expect(
      await screen.findByRole("searchbox", { name: "search exercises" }),
    ).toBeTruthy();
  });

  it("records a hero skip with a reason chip as a SkipRecord, cached under sessionSkips", async () => {
    // Same fixture note as "offers Swap exercise" above.
    resetDbForTests();
    await cacheSet(cacheKeys.activeSession, active);
    await cacheSet(cacheKeys.sessionRx(active.id), [bench]);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    vi.mocked(getServerSessionSets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Out of time" }));

    const cached = await cacheGet<Record<string, unknown>>(
      cacheKeys.sessionSkips(active.id),
    );
    expect(cached?.bench).toMatchObject({
      entryKey: "bench",
      exerciseId: "bench-press",
      scope: "exercise",
      reason: "Out of time",
    });
    expect(screen.getByRole("button", { name: "Unskip" })).toBeTruthy();
  });

  it("reads a legacy string-array skip cache as SkipRecords with no reason", async () => {
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench"]);

    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /— current — view full workout$/ }),
    );
    expect(screen.getByRole("button", { name: "UNSKIP" })).toBeTruthy();
  });
});
