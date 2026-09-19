// @vitest-environment jsdom
//
// Today remounts fresh the instant End navigates home, and its DONE read
// is online-first (data.ts's fetchWithCache tries the server before ever
// touching the cache). enqueue() only FIRES a flush; it doesn't wait for
// one. Without an explicit flush in end(), Today's fresh read can win the
// race against our own write and come back "not done" for a session that
// just ended.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

const flush = vi.fn().mockResolvedValue(undefined);
const pendingSets = vi.fn().mockResolvedValue([]);
const enqueue = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/sync", () => ({
  outbox: {
    enqueue: (...a: unknown[]) => enqueue(...a),
    flush: (...a: unknown[]) => flush(...a),
    pendingSets: (...a: unknown[]) => pendingSets(...a),
  },
}));

import { End } from "./End";
import { cacheGet, cacheSet, cacheKeys, resetDbForTests } from "../lib/db";

const ACTIVE = {
  id: "sess-1",
  planned_workout_id: "w-1",
  started_at: "2026-09-16T10:00:00.000Z",
  workout_label: "Lower",
  plan_note: null,
  coach_note: null,
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  flush.mockResolvedValue(undefined);
  enqueue.mockResolvedValue(undefined);
  pendingSets.mockResolvedValue([
    {
      id: "set-1",
      session_id: ACTIVE.id,
      exercise_id: "Barbell_Squat",
      prescription_id: null,
      set_index: 0,
      set_type: "working",
      load_kg: 100,
      reps: 5,
      performed_at: ACTIVE.started_at,
      rest_seconds_actual: null,
    },
  ]);
  await cacheSet(cacheKeys.activeSession, ACTIVE);
});

afterEach(cleanup);

describe("End: finishing a session", () => {
  it("flushes the queue before leaving, so Today's next read is not racing our own write", async () => {
    render(<End />);
    // Wait for the set-count summary to settle (several cacheGet round trips
    // behind the button's own first paint) before tapping Finish — otherwise
    // a fast synchronous click can race the in-flight local-count read the
    // same way the bug under test does, for a reason that has nothing to do
    // with the fix this test exists to cover.
    const finishBtn = await screen.findByRole("button", {
      name: "End session",
    });
    await screen.findByText(/SET.*LOGGED/);
    fireEvent.click(finishBtn);

    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());

    const enqueueOrder = enqueue.mock.invocationCallOrder[0]!;
    const flushOrder = flush.mock.invocationCallOrder[0]!;
    const navigateOrder = navigateMock.mock.invocationCallOrder[0]!;
    expect(enqueueOrder).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(navigateOrder);
  });

  it("records the finished session's set count and duration, keyed by planned day", async () => {
    render(<End />);
    const finishBtn = await screen.findByRole("button", {
      name: "End session",
    });
    // Same reason as above: wait for the settled "1 SET LOGGED" summary
    // (setCount/countKnown, several real cacheGet round trips past the
    // button's own first paint) before clicking, so the assertion below is
    // about the fix under test and not an unrelated render-order race.
    await screen.findByText(/SET.*LOGGED/);
    fireEvent.click(finishBtn);
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalled());

    const summary = await cacheGet<{
      setCount: number;
      durationSeconds: number;
    }>("doneSummary:w-1");
    expect(summary?.setCount).toBe(1);
    expect(summary?.durationSeconds).toBeGreaterThanOrEqual(0);
  });
});
