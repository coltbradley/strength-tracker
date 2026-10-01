// @vitest-environment jsdom
// `started_at` and `ended_at` have existed since the first migration and were
// shown nowhere. The only trap in surfacing them is the format: formatClock
// would render a 72-minute session as "72:00", which reads as 72 seconds.

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  cacheDelete,
  cacheGet,
  cacheKeys,
  cacheSet,
  resetDbForTests,
} from "../lib/db";
import {
  countServerSessionSets,
  invalidateForSessionClose,
  invalidateForSetChange,
} from "../lib/data";
import type {
  ActiveSession,
  ResolvedPrescriptionRow,
  SetInsert,
} from "../lib/types";
import { formatDuration, End } from "./End";

vi.mock("../lib/data", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    countServerSessionSets: vi.fn(async () => 0),
    invalidateForSetChange: vi.fn(async () => undefined),
    invalidateForSessionClose: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
    inspect: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    enqueueBatch: vi.fn(async () => undefined),
    // end() (Task 12) races this against a 1.5s timeout so Today's
    // online-first read doesn't beat our own write; the mock must resolve
    // or `end()` throws before writeSessionSkips's enqueueBatch is awaited.
    flush: vi.fn(async () => undefined),
  },
}));

import { outbox } from "../lib/sync";

const active: ActiveSession = {
  id: "session-end-1",
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
): ResolvedPrescriptionRow {
  return {
    id,
    planned_workout_id: "workout-1",
    exercise_id: exerciseId,
    exercise_name: name,
    position: 0,
    sets: 1,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 60,
    notes: null,
    load_kg: 100,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 100,
    plate_load_kg: null,
    superset_group: null,
  };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(countServerSessionSets).mockReset();
  vi.mocked(invalidateForSessionClose).mockReset();
  vi.mocked(invalidateForSetChange).mockReset();
  vi.mocked(outbox.enqueue).mockReset();
  vi.mocked(outbox.enqueueBatch).mockReset();
  vi.mocked(outbox.flush).mockReset();
  vi.mocked(countServerSessionSets).mockResolvedValue(0);
  vi.mocked(invalidateForSessionClose).mockResolvedValue(undefined);
  vi.mocked(invalidateForSetChange).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(outbox.enqueueBatch).mockResolvedValue(undefined);
  vi.mocked(outbox.flush).mockResolvedValue(undefined);
  await cacheSet(cacheKeys.activeSession, active);
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await cacheDelete(cacheKeys.activeSession);
  cleanup();
});

describe("formatDuration", () => {
  it("reads in minutes under an hour", () => {
    expect(formatDuration(0)).toBe("0 MIN");
    expect(formatDuration(59)).toBe("0 MIN");
    expect(formatDuration(47 * 60)).toBe("47 MIN");
    expect(formatDuration(59 * 60 + 59)).toBe("59 MIN");
  });

  it("switches to hours rather than counting past 60", () => {
    expect(formatDuration(60 * 60)).toBe("1H 00M");
    expect(formatDuration(72 * 60)).toBe("1H 12M");
    expect(formatDuration(125 * 60 + 30)).toBe("2H 05M");
  });
});

describe("End: session_skips at Finish", () => {
  it("exposes the session summary as a named region before the finish choices", async () => {
    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    const summary = await screen.findByRole("region", { name: "Session summary" });
    expect(summary.textContent).toMatch(/SET COUNT UNKNOWN OFFLINE|SETS? LOGGED/);
    expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to session" })).toBeTruthy();
  });

  it("keeps Finish safe when local zero is not confirmed by the server", async () => {
    vi.mocked(countServerSessionSets).mockRejectedValueOnce(new Error("offline"));
    await cacheSet(cacheKeys.sessionSets(active.id), []);

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/couldn’t reach the server/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard empty session" })).toBeNull();
  });

  it("retains the selected session rating and note in the existing Finish payload", async () => {
    const loggedSet: SetInsert = {
      id: "end-test-set-1",
      session_id: active.id,
      exercise_id: "bench-press",
      prescription_id: null,
      set_index: 0,
      set_type: "working",
      load_kg: 100,
      reps: 5,
      performed_at: active.started_at,
      rest_seconds_actual: null,
    };
    await cacheSet(cacheKeys.sessionSets(active.id), [loggedSet]);

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    await screen.findByText(/1 SET LOGGED/);
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    expect(screen.getByRole("button", { name: "7" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "8" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "+ Note" }));
    fireEvent.change(screen.getByPlaceholderText("How did it go?"), {
      target: { value: "Kept the last set smooth." },
    });
    const endButton = screen.getByRole("button", { name: "End session" });
    expect(endButton.isConnected).toBe(true);
    fireEvent.click(endButton);

    // end() reaches enqueue synchronously before its first await. This asserts
    // the current ready control dispatched and preserves the exact payload.
    expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledOnce();
    expect(vi.mocked(outbox.enqueue).mock.calls[0]?.[0]).toMatchObject({
      kind: "update",
      table: "sessions",
      id: active.id,
      patch: {
        session_rpe: 7,
        notes: "Kept the last set smooth.",
      },
    });
    await vi.waitFor(async () =>
      expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined(),
    );
  });

  it("enqueues one session_skips row per skipped entry, with every column present", async () => {
    const bench = prescription("bench", "bench-press", "Bench Press");
    const squat = prescription("squat", "back-squat", "Back Squat");
    await cacheSet(cacheKeys.sessionRx(active.id), [bench, squat]);
    await cacheSet(cacheKeys.sessionExtras(active.id), []);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    await cacheSet(cacheKeys.sessionSkips(active.id), {
      squat: {
        entryKey: "squat",
        prescriptionId: "squat",
        exerciseId: "back-squat",
        scope: "exercise",
        reason: "Out of time",
      },
    });

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    // A server-confirmed empty session switches from the bootstrap End
    // button to the deliberate "End anyway" action. Wait for that verdict
    // before clicking, so the test cannot pass merely because the button
    // changed during bootstrap.
    fireEvent.click(await screen.findByRole("button", { name: "End anyway (counts as done)" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "insert",
      table: "session_skips",
      payload: {
        session_id: active.id,
        prescription_id: "squat",
        exercise_id: "back-squat",
        scope: "exercise",
        reason: "Out of time",
      },
    });
    expect(typeof (ops[0] as { payload: { id: string } }).payload.id).toBe(
      "string",
    );
  });

  it("resolves a legacy string-array skip to its exercise from rx before writing", async () => {
    const bench = prescription("bench", "bench-press", "Bench Press");
    await cacheSet(cacheKeys.sessionRx(active.id), [bench]);
    await cacheSet(cacheKeys.sessionExtras(active.id), []);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench"]);

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "End anyway (counts as done)" }));
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    expect(ops[0]).toMatchObject({
      payload: { exercise_id: "bench-press", prescription_id: "bench" },
    });
  });

  it("drops a legacy skip whose exercise cannot be resolved rather than queueing a row the server will refuse", async () => {
    const bench = prescription("bench", "bench-press", "Bench Press");
    await cacheSet(cacheKeys.sessionRx(active.id), [bench]);
    await cacheSet(cacheKeys.sessionExtras(active.id), []);
    await cacheSet(cacheKeys.sessionSets(active.id), []);
    // Legacy (plain string[]) cache: "bench" matches a prescription in
    // rxCached and resolves; "ghost" matches neither a prescription id nor
    // an "extra:<id>" and must never reach the outbox with exercise_id ""
    // (session_skips.exercise_id is NOT NULL references exercises(id) — an
    // empty string is a 23503 the outbox classifies as dead, forever).
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench", "ghost"]);

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "End anyway (counts as done)" }));
    // Finish still completes normally: the sessions update and the flush
    // race both still run. A dropped skip must never take the session
    // close down with it.
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.flush)).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueueBatch)).toHaveBeenCalledTimes(1),
    );
    const ops = vi.mocked(outbox.enqueueBatch).mock.calls[0]?.[0] ?? [];
    // Only the resolvable skip survives — one row, not two, and it is
    // "bench"'s, never a row with an empty exercise_id.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      table: "session_skips",
      payload: { exercise_id: "bench-press", prescription_id: "bench" },
    });
    for (const op of ops) {
      expect((op as { payload: { exercise_id: string } }).payload)
        .toHaveProperty("exercise_id");
      expect(
        (op as { payload: { exercise_id: string } }).payload.exercise_id,
      ).not.toBe("");
    }
  });

  it("writes no session_skips batch when nothing was skipped", async () => {
    const bench = prescription("bench", "bench-press", "Bench Press");
    await cacheSet(cacheKeys.sessionRx(active.id), [bench]);
    await cacheSet(cacheKeys.sessionExtras(active.id), []);
    await cacheSet(cacheKeys.sessionSets(active.id), []);

    render(
      <MemoryRouter>
        <End />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "End session" }));

    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "End session" })).toBeNull(),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(outbox.enqueue)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(outbox.enqueueBatch)).not.toHaveBeenCalled();
  });
});

describe("End: decimals sweep", () => {
  for (const unit of ["kg", "lb"] as const) {
    it(`bodyweight reads at human precision in ${unit}`, async () => {
      const { setSetting, resetAllSettings } = await import("../lib/settings");
      setSetting("unit", unit);
      // a converted lb bodyweight stored at 2 decimals of kg
      await cacheSet("lastBodyweightKg", 81.87);
      render(<MemoryRouter><End /></MemoryRouter>);
      await screen.findByRole("region", { name: "Session summary" });
      fireEvent.click(screen.getByRole("button", { name: /bodyweight/i }));
      await screen.findByRole("region", { name: "Bodyweight" });
      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Bodyweight" }).textContent).toMatch(
          unit === "lb" ? /180\.5/ : /81\.9/,
        ),
      );
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const odd: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const m of (n.textContent ?? "").matchAll(/\d+\.\d{2,}|\b\d+\.0\b/g)) odd.push(m[0]);
      }
      expect(odd).toEqual([]);
      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Bodyweight" }).textContent).toMatch(
          unit === "lb" ? /180\.5/ : /81\.9/,
        ),
      );
      resetAllSettings();
    });
  }
});
