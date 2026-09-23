// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SetInsert } from "../lib/types";

const todayRef = vi.hoisted(() => ({ current: "2026-09-23" }));
const pendingSets = vi.hoisted(() =>
  vi.fn(async (_sessionId: string) => [] as SetInsert[]),
);
const pendingVoidIds = vi.hoisted(() => vi.fn(async () => new Set<string>()));
const getServerSessionSets = vi.hoisted(() =>
  vi.fn(async (_id: string) => [] as SetInsert[]),
);

vi.mock("../hooks/useLocalToday", () => ({
  useLocalToday: () => todayRef.current,
}));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/sync", () => ({
  outbox: {
    pendingDiscardIds: vi.fn().mockResolvedValue(new Set()),
    pendingVoidIds: () => pendingVoidIds(),
    pendingSets: (sessionId: string) => pendingSets(sessionId),
    flush: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../lib/checkinHistory", async () => {
  const actual = await vi.importActual<typeof import("../lib/checkinHistory")>(
    "../lib/checkinHistory",
  );
  return {
    ...actual,
    getInjuries: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    getWeekBuckets: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    getWeekCheckins: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
  };
});
vi.mock("../lib/data", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/data")>("../lib/data");
  return {
    ...actual,
    getExercises: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    getLoggedExerciseIds: vi
      .fn()
      .mockResolvedValue({ data: [], fromCache: false }),
    getServerSessionSets: (id: string) => getServerSessionSets(id),
    getBodyweight: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
    recordBodyweight: vi.fn(),
    getObservations: vi.fn().mockResolvedValue({ data: [], fromCache: false }),
  };
});
vi.mock("../lib/sessionHistory", async () => {
  const actual = await vi.importActual<typeof import("../lib/sessionHistory")>(
    "../lib/sessionHistory",
  );
  return {
    ...actual,
    getSessionLog: vi.fn(),
    getWeeklySummary: vi.fn(),
  };
});

import { History } from "./History";
import { getSessionLog, getWeeklySummary } from "../lib/sessionHistory";
import { resetDbForTests } from "../lib/db";

const sessionId = "11111111-1111-4111-8111-111111111111";

function setRow(
  id: string,
  loadKg: number,
  reps: number,
): SetInsert {
  return {
    id,
    session_id: sessionId,
    exercise_id: "back-squat",
    prescription_id: null,
    set_index: loadKg === 100 ? 0 : loadKg === 80 ? 1 : 2,
    set_type: "working",
    load_kg: loadKg,
    reps,
    performed_at:
      loadKg === 100
        ? "2026-09-22T15:10:00.000Z"
        : loadKg === 80
          ? "2026-09-22T15:12:00.000Z"
          : "2026-09-22T15:14:00.000Z",
    rest_seconds_actual: null,
  };
}

const shared = setRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 100, 5);
const queued = setRow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 80, 3);
const voided = setRow("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 60, 8);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  pendingSets.mockResolvedValue([]);
  pendingVoidIds.mockResolvedValue(new Set());
  getServerSessionSets.mockResolvedValue([]);
  vi.mocked(getSessionLog).mockResolvedValue({
    data: [
      {
        id: sessionId,
        started_at: "2026-09-22T15:00:00.000Z",
        ended_at: "2026-09-22T16:00:00.000Z",
        session_rpe: null,
        label: "Lower",
        setCount: 2,
      },
    ],
    fromCache: true,
  });
  vi.mocked(getWeeklySummary).mockResolvedValue({
    data: null,
    fromCache: false,
  });
});

afterEach(cleanup);

describe("History queued sets", () => {
  it("shows a queued set once beside the server sets, and hides a pending void", async () => {
    getServerSessionSets.mockResolvedValue([shared, voided]);
    pendingSets.mockResolvedValue([shared, queued]);
    pendingVoidIds.mockResolvedValue(new Set([voided.id]));

    render(<History userId="ffffffff-1111-4111-8111-111111111111" />);

    fireEvent.click(await screen.findByRole("button", { name: /Lower/ }));

    expect(await screen.findByText(/80 kg × 3/)).toBeTruthy();
    expect(screen.getAllByText(/100 kg × 5/)).toHaveLength(1);
    expect(screen.getAllByText(/80 kg × 3/)).toHaveLength(1);
    expect(screen.queryByText(/60 kg × 8/)).toBeNull();
  });
});
