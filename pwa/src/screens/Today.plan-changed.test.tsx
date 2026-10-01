// @vitest-environment jsdom
//
// A coach turn writes through the MCP server, outside the PWA's mutation
// helpers, so `onPlanChanged` (lib/planChanges) is the only signal an
// already-open Today screen gets that its cached prescriptions are stale.
// The handler clears every cached prescription (`setRx({})`) and reloads —
// but "reload" only ever re-fetched the SELECTED date's workout. For an
// undated DAY 1..N program there is no selected date at all: the only
// "currently visible" prescriptions are whichever row someone tapped open
// (`expanded`), and nothing re-fetched that row, so its exercise list went
// blank until it was collapsed and reopened.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const {
  getPlannedWorkouts,
  getDoneWorkoutIds,
  getResolvedPrescriptions,
  getUnratedSession,
  syncOpenSessions,
} = vi.hoisted(() => ({
  getPlannedWorkouts: vi.fn(),
  getDoneWorkoutIds: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getUnratedSession: vi.fn(),
  syncOpenSessions: vi.fn(),
}));

vi.mock("../lib/data", () => ({
  getPlannedWorkouts: (...a: unknown[]) => getPlannedWorkouts(...a),
  getDoneWorkoutIds: (...a: unknown[]) => getDoneWorkoutIds(...a),
  getResolvedPrescriptions: (...a: unknown[]) => getResolvedPrescriptions(...a),
  getUnratedSession: (...a: unknown[]) => getUnratedSession(...a),
  syncOpenSessions: (...a: unknown[]) => syncOpenSessions(...a),
  getExercises: vi
    .fn()
    .mockResolvedValue({ data: [], fromCache: false, stale: null }),
  getLastActuals: vi
    .fn()
    .mockResolvedValue({ data: [], fromCache: false, stale: null }),
  getServerSessionSets: vi.fn().mockResolvedValue([]),
  mergeSets: (a: { id: string }[], b: { id: string }[]) => [
    ...new Map([...a, ...b].map((r) => [r.id, r])).values(),
  ],
  invalidateForSessionClose: vi.fn().mockResolvedValue(undefined),
  staleReason: () => "error",
  updatePlannedWorkout: vi.fn(),
  createPlannedWorkout: vi.fn(),
  applyTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  weekOrder: (a: { day_index: number }, b: { day_index: number }) =>
    a.day_index - b.day_index,
  // Not exercised here (the sheet this test renders Today around is never
  // opened), but CheckInSheet -> checkinHistory.ts calls this at module load,
  // so a mock missing it throws before any test body runs.
  makeFetchWithCache:
    () => async (_key: string, fetcher: () => Promise<unknown>) => ({
      data: await fetcher(),
      fromCache: false,
      stale: null,
    }),
  throwIf: () => {},
}));

vi.mock("../lib/sync", () => {
  const status = { pending: 0, dead: 0, held: 0, state: "idle", lastError: null };
  return {
  outbox: {
    subscribe: () => () => {},
    getStatus: () => status,
    pendingSets: vi.fn().mockResolvedValue([]),
    pendingVoidIds: vi.fn().mockResolvedValue(new Set()),
    flush: vi.fn().mockResolvedValue(undefined),
    pendingSessionUpdateIds: vi.fn().mockResolvedValue(new Set()),
    pendingRatedSessionIds: vi.fn().mockResolvedValue(new Set()),
    inspect: vi.fn().mockResolvedValue([]),
    enqueue: vi.fn(),
  },
  };
});

vi.mock("../lib/errors", () => ({
  reportError: vi.fn(),
  toast: vi.fn(),
}));

import { Today } from "./Today";
import { notifyPlanChanged } from "../lib/planChanges";
import { cacheGet, cacheKeys, resetDbForTests } from "../lib/db";
import * as db from "../lib/db";
import { outbox } from "../lib/sync";
import { getServerSessionSets } from "../lib/data";
import { formatPlannedDate, todayLocalIso } from "../lib/format";

const PROGRAM = {
  id: "prog-1",
  name: "Full Body",
  source_note: null,
  created_at: "2026-09-01T00:00:00Z",
  confirmed_at: "2026-09-01T00:00:00Z",
};

// scheduled_date: null on every day -> anyDates is false -> the undated
// DAY 1..N fallback list, which is exactly the case with no `selectedWorkout`.
const WORKOUT = {
  id: "w1",
  program_id: PROGRAM.id,
  day_index: 0,
  label: "Day 1",
  notes: null,
  scheduled_date: null,
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
};

const rxRow = (name: string) => ({
  id: `${name}-rx`,
  planned_workout_id: WORKOUT.id,
  exercise_id: name,
  exercise_name: name,
  position: 0,
  sets: 3,
  reps_min: 5,
  reps_max: 5,
  rest_seconds: null,
  notes: null,
  load_kg: 60,
  load_pct_tm: null,
  tm_kg: null,
  resolved_load_kg: 60,
  plate_load_kg: null,
  superset_group: null,
});

afterEach(cleanup);

// The preview keeps Start disabled until the day's prescriptions have loaded,
// and a click on a disabled button does nothing. Clicking straight after Go
// raced that fetch and failed under CI load with enqueue never called.
async function clickStartWhenReady() {
  const start = screen.getByRole("button", { name: "Start workout" });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  getPlannedWorkouts.mockResolvedValue({
    data: { programs: [PROGRAM], workouts: [WORKOUT] },
    fromCache: false,
    stale: null,
  });
  getDoneWorkoutIds.mockResolvedValue({
    data: [],
    fromCache: false,
    stale: null,
  });
  getUnratedSession.mockResolvedValue(null);
  syncOpenSessions.mockResolvedValue({
    clearedActive: false,
    autoCompleted: 0,
    autoDiscarded: 0,
    orphan: null,
  });
  getResolvedPrescriptions.mockResolvedValue({
    data: [rxRow("Squat")],
    fromCache: false,
    stale: null,
  });
});

describe("Today + coach plan changes (onPlanChanged)", () => {
  it("promotes the next actionable workout after today's workout is complete", async () => {
    const today = todayLocalIso();
    const tomorrowDate = new Date(`${today}T12:00:00`);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = [
      tomorrowDate.getFullYear(),
      String(tomorrowDate.getMonth() + 1).padStart(2, "0"),
      String(tomorrowDate.getDate()).padStart(2, "0"),
    ].join("-");
    const completedToday = {
      ...WORKOUT,
      id: "completed-today",
      label: "Upper strength",
      scheduled_date: today,
    };
    const next = {
      ...WORKOUT,
      id: "next",
      label: "Lower strength",
      scheduled_date: tomorrow,
    };
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [completedToday, next] },
      fromCache: false,
      stale: null,
    });
    getDoneWorkoutIds.mockResolvedValue({
      data: [completedToday.id],
      fromCache: false,
      stale: null,
    });

    render(<Today presentation="train" userId="u1" />);

    // Finishing is confirmed first; only then does the screen talk about rest.
    expect(await screen.findByRole("heading", { name: "Recover." })).toBeTruthy();
    // "checking…" until the outbox has been read, then the proven claim
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "✓ Upper strength finished · nothing waiting on this phone",
      ),
    );
    expect(screen.queryByText("Rest day")).toBeNull();
    expect(screen.getByText("Lower strength")).toBeTruthy();
    // the week strip says DONE for today (ended session) and NEXT for tomorrow
    const words = [...document.querySelectorAll(".train-day-word")].map(
      (n) => n.textContent,
    );
    expect(words.filter((w) => w === "DONE")).toHaveLength(1);
    expect(words.filter((w) => w === "NEXT")).toHaveLength(1);
    expect(screen.getByText(`NEXT · ${formatPlannedDate(tomorrow)}`)).toBeTruthy();
    const go = screen.getByRole("button", { name: "Go" });
    expect(go.className).toContain("btn-primary");
    const viewRecord = screen.getByRole("link", { name: "View record" });
    expect(viewRecord.getAttribute("href")).toBe("/history");
    expect(viewRecord.className).toContain("train-link");

    fireEvent.click(go);
    expect(screen.getByRole("dialog", { name: "Lower strength preview" })).toBeTruthy();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });

  it("an open session never makes today DONE, and a DRAFT today is never missed", async () => {
    const today = todayLocalIso();
    const open = { ...WORKOUT, id: "open", label: "Upper", scheduled_date: today };
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [open] },
      fromCache: false,
      stale: null,
    });
    // getDoneWorkoutIds only ever returns ended sessions; an open one is absent
    getDoneWorkoutIds.mockResolvedValue({ data: [], fromCache: false, stale: null });

    const view = render(<Today presentation="train" userId="u1" />);
    await screen.findByRole("button", { name: "Go" });
    expect(screen.queryByText(/finished/)).toBeNull();
    const words = () =>
      [...document.querySelectorAll(".train-day-word")].map((n) => n.textContent);
    expect(words().filter((w) => w === "TODAY")).toHaveLength(1);
    expect(words()).not.toContain("DONE");
    view.unmount();

    // an empty planned day dated in the past is a draft, not a missed workout
    const past = new Date(`${today}T12:00:00`);
    past.setDate(past.getDate() - 1);
    const pastIso = todayLocalIso(past);
    const draft = { ...WORKOUT, id: "draft", label: "Unwritten", scheduled_date: pastIso, exercise_count: 0 };
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [draft, { ...open, id: "t2" }] },
      fromCache: false,
      stale: null,
    });
    render(<Today presentation="train" userId="u1" />);
    await screen.findByRole("button", { name: "Go" });
    const w2 = words();
    expect(w2).toContain("DRAFT");
    expect(w2).not.toContain("MISSED");
  });

  it("keeps the newer plan when an older read answers last (A-13)", async () => {
    // The mount read is slow; a coach edit triggers a second read that
    // answers first. The late mount read must not put the old plan back.
    let resolveFirst!: (v: unknown) => void;
    const future = { ...WORKOUT, scheduled_date: "2099-01-02" };
    getPlannedWorkouts
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValue({
        data: { programs: [PROGRAM], workouts: [{ ...future, label: "New label" }] },
        fromCache: false,
        stale: null,
      });

    render(<Today presentation="train" userId="u1" />);
    await waitFor(() => expect(getPlannedWorkouts).toHaveBeenCalledTimes(1));
    notifyPlanChanged();
    expect(await screen.findByText("New label")).toBeTruthy();

    resolveFirst({
      data: { programs: [PROGRAM], workouts: [{ ...future, label: "Old label" }] },
      fromCache: false,
      stale: null,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Old label")).toBeNull();
    expect(screen.getByText("New label")).toBeTruthy();
  });

  it("shows the earliest actionable future workout from Rest day", async () => {
    const draft = { ...WORKOUT, id: "draft", label: "Unwritten", scheduled_date: "2099-01-01", exercise_count: 0 };
    const next = { ...WORKOUT, id: "next", label: "Lower strength", scheduled_date: "2099-01-02" };
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [draft, next] },
      fromCache: false,
      stale: null,
    });

    render(<Today presentation="train" userId="u1" />);

    expect(await screen.findByRole("button", { name: "Go" })).toBeTruthy();
    expect(screen.getByText("REST DAY")).toBeTruthy();
    expect(screen.getByText("Lower strength")).toBeTruthy();
    expect(screen.queryByText("Unwritten")).toBeNull();
    // no confirmation when nothing was finished today
    expect(screen.queryByText(/finished/)).toBeNull();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
  });

  it("keeps Go and every preview dismissal read-only", async () => {
    render(<Today presentation="train" userId="u1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Go" }));
    expect(screen.getByRole("dialog", { name: "Day 1 preview" })).toBeTruthy();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });

  it("does not publish an active session when durable session enqueue fails", async () => {
    vi.mocked(outbox.enqueue).mockRejectedValueOnce(
      new Error("IndexedDB unavailable"),
    );
    render(<Today presentation="train" userId="u1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Go" }));
    await clickStartWhenReady();

    await waitFor(() => expect(outbox.enqueue).toHaveBeenCalledTimes(1));
    expect(await cacheGet(cacheKeys.activeSession)).toBeUndefined();
  });

  it("keeps a queued session resumable when caching its targets fails", async () => {
    const realCacheSet = db.cacheSet;
    const cacheSet = vi
      .spyOn(db, "cacheSet")
      .mockImplementation(async (key, value) => {
        if (key.startsWith("sessionRx:"))
          throw new Error("target cache quota exceeded");
        await realCacheSet(key, value);
      });
    try {
      render(<Today presentation="train" userId="u1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Go" }));
      await clickStartWhenReady();

      await waitFor(() => expect(outbox.enqueue).toHaveBeenCalledTimes(1));
      await waitFor(async () =>
        expect(await cacheGet(cacheKeys.activeSession)).toMatchObject({
          planned_workout_id: WORKOUT.id,
        }),
      );
    } finally {
      cacheSet.mockRestore();
    }
  });

  it("holds a queued session on Today when the active-session cache write fails", async () => {
    const realCacheSet = db.cacheSet;
    const cacheSet = vi
      .spyOn(db, "cacheSet")
      .mockImplementation(async (key, value) => {
        if (key === cacheKeys.activeSession)
          throw new Error("active-session cache unavailable");
        await realCacheSet(key, value);
      });
    try {
      render(<Today presentation="train" userId="u1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Go" }));
      await clickStartWhenReady();

      await waitFor(() => expect(outbox.enqueue).toHaveBeenCalledTimes(1));
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /session was saved locally.*couldn.t open it/i,
      );
      expect(
        screen.getByRole("button", { name: "Retry opening session" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
    } finally {
      cacheSet.mockRestore();
    }
  });

  it("recovers an offline queued session when its active pointer is absent after reload", async () => {
    vi.mocked(outbox.inspect).mockResolvedValueOnce([
      {
        key: 1,
        table: "sessions",
        created_at: "2026-09-23T10:00:00Z",
        retries: 0,
        last_error: null,
        user_id: "u1",
        state: "waiting",
        cause: null,
        retryable: false,
        op: {
          kind: "insert",
          table: "sessions",
          payload: {
            id: "queued-session",
            planned_workout_id: WORKOUT.id,
            started_at: "2026-09-23T10:00:00Z",
          },
        },
      },
    ]);
    render(<Today presentation="train" userId="u1" />);

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /session was saved locally.*couldn.t open it/i,
    );
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("reloads a currently-expanded undated day instead of leaving it blank", async () => {
    render(<Today userId="u1" />);

    // The DAY 1..N fallback auto-expands today's row on mount.
    await screen.findByText("Squat");

    // A coach turn rewrote the day while this screen was still open.
    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });
    notifyPlanChanged();

    await waitFor(() => expect(screen.queryByText("Squat")).toBeNull());
    // Must recover with the freshly-written plan, not sit blank forever.
    await waitFor(() => expect(screen.queryByText("Deadlift")).toBeTruthy());
  });

  it("renders Train as a separate surface while leaving Program's tree intact", async () => {
    render(<Today presentation="train" />);

    await screen.findByText("Day 1");
    expect(await screen.findByText("1 movement · 3 sets")).toBeTruthy();
    expect(screen.getByText("Squat")).toBeTruthy();
    expect(screen.queryByText("THIS WEEK")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByText("3×5")).toBeNull();
  });

  it("shows a failed Train details read and retries it when the plan refreshes", async () => {
    getResolvedPrescriptions.mockRejectedValue(new Error("connection lost"));

    render(<Today presentation="train" />);

    await screen.findByText(
      "Couldn’t load workout details. Refresh your plan to retry.",
    );

    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });

    notifyPlanChanged();

    expect(await screen.findByText("Deadlift")).toBeTruthy();
    expect(getResolvedPrescriptions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["offline", "Offline, showing saved workout details."],
    ["error", "Couldn’t refresh, showing saved workout details."],
  ] as const)(
    "keeps cached %s Train details usable while naming their freshness",
    async (stale, note) => {
      getResolvedPrescriptions.mockResolvedValue({
        data: [rxRow("Squat")],
        fromCache: true,
        stale,
      });

      render(<Today presentation="train" />);

      expect(await screen.findByText("1 movement · 3 sets")).toBeTruthy();
      expect(screen.getByText(note)).toBeTruthy();
    },
  );

  it("replaces stale cached Train details when the plan refreshes", async () => {
    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Squat")],
      fromCache: true,
      stale: "offline",
    });

    render(<Today presentation="train" />);

    await screen.findByText("Offline, showing saved workout details.");

    getResolvedPrescriptions.mockResolvedValue({
      data: [rxRow("Deadlift")],
      fromCache: false,
      stale: null,
    });
    notifyPlanChanged();

    expect(await screen.findByText("Deadlift")).toBeTruthy();
    expect(
      screen.queryByText("Offline, showing saved workout details."),
    ).toBeNull();
    expect(getResolvedPrescriptions).toHaveBeenCalledTimes(2);
  });

  it("coalesces Train's overlapping prescription load for an undated workout", async () => {
    let resolveRead: (value: {
      data: ReturnType<typeof rxRow>[];
      fromCache: boolean;
      stale: null;
    }) => void;
    getResolvedPrescriptions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    render(<Today presentation="train" />);

    await waitFor(() =>
      expect(getResolvedPrescriptions).toHaveBeenCalledTimes(1),
    );
    resolveRead!({ data: [rxRow("Squat")], fromCache: false, stale: null });
  });

  // ---- Train audit fixes (T1-T5, programs[0]) -------------------------------
  const isoPlus = (n: number) => {
    const d = new Date(`${todayLocalIso()}T12:00:00`);
    d.setDate(d.getDate() + n);
    return todayLocalIso(d);
  };
  const dated = (id: string, date: string, extra = {}) => ({
    ...WORKOUT,
    id,
    label: id,
    scheduled_date: date,
    ...extra,
  });
  const words = () =>
    [...document.querySelectorAll(".train-day-word")].map((n) => n.textContent);
  const setEntry = (state: "waiting" | "held" | "dead", table = "sets") =>
    ({
      key: 1,
      table,
      created_at: null,
      retries: 0,
      last_error: null,
      user_id: state === "held" ? null : "u1",
      state,
      cause: null,
      retryable: false,
      op: { kind: "insert", table, payload: { id: "x", session_id: "s" } },
    }) as never;
  const finishedToday = () => {
    const w = dated("done-today", todayLocalIso(), { label: "Upper" });
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [w] },
      fromCache: false,
      stale: null,
    });
    getDoneWorkoutIds.mockResolvedValue({ data: [w.id], fromCache: false, stale: null });
  };

  it("T1: held sets, or an unknown identity, never read as on the server", async () => {
    finishedToday();
    vi.mocked(outbox.inspect).mockResolvedValue([setEntry("held")]);
    const view = render(<Today presentation="train" userId="u1" />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("1 waiting on this phone"),
    );
    expect(screen.getByRole("status").textContent).not.toContain("on the server");
    view.unmount();

    vi.mocked(outbox.inspect).mockResolvedValue([]);
    render(<Today presentation="train" userId={null} />);
    await screen.findByRole("heading", { name: "Recover." });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("status").textContent).toContain("checking…");
    expect(screen.getByRole("status").textContent).not.toContain("on the server");
    vi.mocked(outbox.inspect).mockResolvedValue([]);
  });

  it("T2: only set writes are sets", async () => {
    finishedToday();
    vi.mocked(outbox.inspect).mockResolvedValue([setEntry("waiting", "set_voids"), setEntry("dead", "bodyweight_log")]);
    render(<Today presentation="train" userId="u1" />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "nothing waiting on this phone · 2 other changes waiting",
      ),
    );
    vi.mocked(outbox.inspect).mockResolvedValue([]);
  });

  it("T3: a failed server read shows no count; pending voids are subtracted", async () => {
    const w = dated("act", todayLocalIso(), { label: "Upper" });
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [w] },
      fromCache: false,
      stale: null,
    });
    await db.cacheSet(cacheKeys.activeSession, {
      id: "sess-1",
      planned_workout_id: w.id,
      started_at: new Date().toISOString(),
      workout_label: "Upper",
    });
    const s = (id: string) => ({ id, session_id: "sess-1" }) as never;
    vi.mocked(getServerSessionSets).mockResolvedValue(null as never);
    const view = render(<Today presentation="train" userId="u1" />);
    await screen.findByRole("link", { name: "Resume" });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/sets? logged/)).toBeNull();
    view.unmount();

    vi.mocked(getServerSessionSets).mockResolvedValue([s("a"), s("b"), s("c")]);
    vi.mocked(outbox.pendingSets).mockResolvedValue([s("d")]);
    vi.mocked(outbox.pendingVoidIds).mockResolvedValue(new Set(["b"]));
    render(<Today presentation="train" userId="u1" />);
    expect(await screen.findByText("3 sets logged · 3 planned")).toBeTruthy();
    vi.mocked(getServerSessionSets).mockResolvedValue([]);
    vi.mocked(outbox.pendingSets).mockResolvedValue([]);
    vi.mocked(outbox.pendingVoidIds).mockResolvedValue(new Set());
  });

  it("T4: a failed done-state read reads PAST, not MISSED", async () => {
    const past = dated("old", isoPlus(-1));
    const now = dated("now", todayLocalIso());
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [past, now] },
      fromCache: false,
      stale: null,
    });
    getDoneWorkoutIds.mockRejectedValue(new Error("offline"));
    render(<Today presentation="train" userId="u1" />);
    await screen.findByRole("button", { name: "Go" });
    expect(words()).toContain("PAST");
    expect(words()).not.toContain("MISSED");
    getDoneWorkoutIds.mockResolvedValue({ data: [], fromCache: false, stale: null });
  });

  it("T4: once the done-state is known an unfinished past day is MISSED", async () => {
    const past = dated("old", isoPlus(-1));
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [past, dated("now", todayLocalIso())] },
      fromCache: false,
      stale: null,
    });
    render(<Today presentation="train" userId="u1" />);
    await waitFor(() => expect(words()).toContain("MISSED"));
    expect(words()).not.toContain("PAST");
  });

  it("T5: a done workout never hides today's pending one in the strip", async () => {
    const a = dated("a", todayLocalIso(), { day_index: 0 });
    const b = dated("b", todayLocalIso(), { day_index: 1 });
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM], workouts: [a, b] },
      fromCache: false,
      stale: null,
    });
    getDoneWorkoutIds.mockResolvedValue({ data: ["a"], fromCache: false, stale: null });
    render(<Today presentation="train" userId="u1" />);
    await screen.findByRole("button", { name: "Go" });
    expect(words().filter((w) => w === "TODAY")).toHaveLength(1);
    expect(words()).not.toContain("DONE");
    getDoneWorkoutIds.mockResolvedValue({ data: [], fromCache: false, stale: null });
  });

  it("shows a second confirmed program's dated days instead of hiding them", async () => {
    const second = { ...PROGRAM, id: "prog-2", name: "Second block", created_at: "2026-08-01T00:00:00Z" };
    const mine = dated("first-prog", isoPlus(2), { program_id: PROGRAM.id });
    const other = dated("second-prog", todayLocalIso(), { program_id: second.id });
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM, second], workouts: [mine, other] },
      fromCache: false,
      stale: null,
    });
    render(<Today presentation="train" userId="u1" />);
    expect(await screen.findByRole("heading", { name: "second-prog" })).toBeTruthy();
    expect(screen.getByText(/TODAY · Second block/)).toBeTruthy();
    expect(getDoneWorkoutIds).toHaveBeenCalledWith(second.id, [other.id]);
    expect(getDoneWorkoutIds).toHaveBeenCalledWith(PROGRAM.id, [mine.id]);
  });

  it("names, rather than hides, a second program when plans are undated", async () => {
    const second = { ...PROGRAM, id: "prog-2", name: "Second block", created_at: "2026-08-01T00:00:00Z" };
    getPlannedWorkouts.mockResolvedValue({
      data: { programs: [PROGRAM, second], workouts: [WORKOUT, { ...WORKOUT, id: "w2", program_id: second.id }] },
      fromCache: false,
      stale: null,
    });
    render(<Today presentation="train" userId="u1" />);
    expect(await screen.findByText(/Also confirmed, not shown here: Second block/)).toBeTruthy();
  });
});
