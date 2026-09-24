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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

const flush = vi.fn().mockResolvedValue(undefined);
const pendingSets = vi.fn().mockResolvedValue([]);
const enqueue = vi.fn().mockResolvedValue(undefined);
const inspect = vi.fn().mockResolvedValue([]);
const listeners = new Set<() => void>();
const subscribe = vi.fn((fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
});
const countServerSessionSets = vi.fn().mockResolvedValue(0);
vi.mock("../lib/data", () => ({
  countServerSessionSets: () => countServerSessionSets(),
  invalidateForSessionClose: vi.fn().mockResolvedValue(undefined),
  invalidateForSetChange: vi.fn().mockResolvedValue(undefined),
  resolveSessionSetCount: (local: number, server: number | null) =>
    local > 0
      ? { count: local, authoritative: true }
      : server === null
        ? { count: 0, authoritative: false }
        : { count: server, authoritative: true },
}));
vi.mock("../lib/sync", () => ({
  outbox: {
    enqueue: (...a: unknown[]) => enqueue(...a),
    flush: (...a: unknown[]) => flush(...a),
    pendingSets: (...a: unknown[]) => pendingSets(...a),
    inspect: () => inspect(),
    subscribe: (fn: () => void) => subscribe(fn),
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
  inspect.mockResolvedValue([]);
  listeners.clear();
  subscribe.mockImplementation((fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  });
  countServerSessionSets.mockResolvedValue(0);
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
  it("does not offer discard when the session has logged sets", async () => {
    render(<End />);
    await screen.findByRole("button", { name: "End session" });
    await screen.findByText(/SET.*LOGGED/);
    expect(screen.queryByRole("button", { name: "Discard session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard session?" })).toBeNull();
  });

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

  it("keeps the active session open while an offline discard is pending", async () => {
    pendingSets.mockResolvedValue([]);
    let accepted = false;
    inspect.mockImplementation(async () => {
      if (accepted) return [];
      const op = enqueue.mock.calls[0]?.[0] as {
        id: string;
        patch: { discarded_at: string };
      } | undefined;
      return op
        ? [{
            key: 1,
            op: { kind: "update", table: "sessions", ...op },
            table: "sessions",
            created_at: op.patch.discarded_at,
            retries: 0,
            last_error: null,
            user_id: "user-1",
            state: "waiting",
            cause: null,
            retryable: false,
          }]
        : [];
    });

    render(<End />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard empty session" }));

    await screen.findByText(/waiting to sync/i);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(await cacheGet(cacheKeys.activeSession)).toEqual(ACTIVE);

    accepted = true;
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("clears the active session only after the discard leaves the outbox", async () => {
    pendingSets.mockResolvedValue([]);
    render(<End />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard empty session" }));

    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }));
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });

  it("explains a late remote set and keeps the session active when discard is rejected", async () => {
    pendingSets.mockResolvedValue([]);
    inspect.mockImplementation(async () => {
      const op = enqueue.mock.calls[0]?.[0] as {
        id: string;
        patch: { discarded_at: string };
      } | undefined;
      return op
        ? [{
            key: 1,
            op: { kind: "update", table: "sessions", ...op },
            table: "sessions",
            created_at: op.patch.discarded_at,
            retries: 1,
            last_error: "cannot discard a session that contains sets",
            last_code: "23514",
            last_status: 400,
            user_id: "user-1",
            state: "dead",
            cause: "rejected",
            retryable: false,
          }]
        : [];
    });

    render(<End />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard empty session" }));

    await screen.findByText(/set from another device.*reached/i);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(await cacheGet(cacheKeys.activeSession)).toEqual(ACTIVE);
  });
});
