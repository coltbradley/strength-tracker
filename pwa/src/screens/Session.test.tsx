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
  within,
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
    getExactSetReceiptIds: vi.fn(async () => ({ setIds: new Set<string>(), voidIds: new Set<string>() })),
  };
});

// getStatus() is a useSyncExternalStore snapshot: it must return the SAME
// object until the status changes, exactly like the real outbox.
const idleStatus = vi.hoisted(() => ({ pending: 0, dead: 0, held: 0, state: "idle", lastError: null }));

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    enqueueCorrection: vi.fn(async () => undefined),
    inspect: vi.fn(async () => []),
    correctionLinks: vi.fn(async () => ({})),
    subscribe: vi.fn(() => () => undefined),
    subscribeSynced: vi.fn(() => () => undefined),
    getStatus: vi.fn(() => idleStatus),
    isStatusKnown: vi.fn(() => true),
  },
}));

vi.mock("../lib/currentUser", () => ({
  getCurrentUserId: () => "aaaaaaaa-1111-4111-8111-111111111111",
  onUserChange: () => () => undefined,
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
  it("keeps a staged correction on its source entry when another entry is selected", async () => {
    render(
      <MemoryRouter>
        <Session />
      </MemoryRouter>,
    );

    // Bench is done, so the session opens on Squat. Open Bench in List and
    // start correcting its logged set.
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bench Press — done/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Correct logged set 1/ }));
    const sheet = within(await screen.findByRole("dialog", { name: /^Fix / }));
    fireEvent.click(sheet.getByRole("button", { name: "increase reps by 1" }));
    expect(
      sheet.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toContain("9");

    // The Fix sheet's backdrop covers the header in a real browser, so this is
    // a robustness check (jsdom has no hit testing): jumping to another entry
    // leaves the sheet's own draft with its source entry.
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    const today = within(screen.getByRole("dialog", { name: "Today's workout" }));
    fireEvent.click(today.getByRole("button", { name: /^Back Squat/ }));
    expect(
      within(screen.getByRole("dialog", { name: /^Fix / })).getByRole("button", {
        name: "reps value — tap to type",
      }).textContent,
    ).toContain("9");
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
    // while the write is in flight the key reads Saving… and is disabled, so
    // a second tap cannot even reach the handler
    fireEvent.click(screen.getByRole("button", { name: /log set|saving/i }));
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1);
    // once the write settles, the 200 ms lock still refuses a second tap and
    // flashes the key
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /log set/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Fix last" }));
    const sheet = within(await screen.findByRole("dialog", { name: /^Fix / }));
    // No jest-dom in this project (see CheckInSheet.render.test.tsx) -- read
    // the DOM state toBeDisabled() would, without adding a dependency.
    const saveButton = sheet.getByRole("button", {
      name: "Save correction",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(sheet.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(saveButton);

    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1),
    );
    const [correctionSessionId, replacement, originalId] =
      vi.mocked(outbox.enqueueCorrection).mock.calls[0] ?? [];
    expect(correctionSessionId).toBe(active.id);
    expect(replacement).toMatchObject({ reps: 6 });
    expect(originalId).toEqual(expect.any(String));
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
      screen
        .getByRole("button", { name: "load value — tap to type" })
        .querySelector(".dock-num-value")?.textContent,
    ).toBe("102.5");

    fireEvent.click(
      screen.getByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "SET REPS" }));
    expect(
      screen
        .getByRole("button", { name: "reps value — tap to type" })
        .querySelector(".dock-num-value")?.textContent,
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

  it("offers Fix last for the newest logged set, which opens its correction sheet", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Fix last" }));

    const sheet = await screen.findByRole("dialog", { name: /^Fix / });
    expect(within(sheet).getByRole("button", { name: "Save correction" })).toBeTruthy();
    expect(sheet.textContent).toContain("145");
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
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));

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
    fireEvent.click(screen.getAllByRole("button", { name: "Skip" })[0]!);
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

    // the session opens on Squat (Bench counts as done); jump back to Bench
    fireEvent.click(await screen.findByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bench Press — skipped/ }));
    expect(await screen.findByRole("button", { name: "Unskip" })).toBeTruthy();
    expect(screen.getByText(/Skipped\. Unskip to log it\./)).toBeTruthy();
  });
});
