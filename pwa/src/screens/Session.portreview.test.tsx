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
  id: "session-aud-1",
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


const exList = () => equipment(
  ["bench-press","Bench Press","barbell"],["barbell-row","Barbell Row","barbell"],
  ["back-squat","Back Squat","barbell"],["fly","Dumbbell Fly","dumbbell"]);


const today = () => fireEvent.click(screen.getByRole("button", { name: /^Today's workout/ }));

describe("N1 staged warmup never leaks into another exercise", () => {
  it("jumping from a warmup-staged squat to a superset logs a WORKING set", async () => {
    exList();
    await seed([
      { ...rx("sqw", "back-squat", "Back Squat", 60, 1), set_type: "warmup" },
      { ...rx("sq", "back-squat", "Back Squat", 100, 2) },
      { ...rx("bench", "bench-press", "Bench Press", 20, 2), superset_group: 1, position: 2 },
      { ...rx("row", "barbell-row", "Barbell Row", 20, 2), superset_group: 1, position: 3 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Back Squat" });
    await pause(120);
    today();
    fireEvent.click(await screen.findByRole("button", { name: /^A1 · Bench Press/ }));
    await screen.findByText("round 1 of 2");
    await pause(150);
    fireEvent.click(screen.getByRole("button", { name: "Log A1" }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    expect(queuedSets()[0].exercise_id).toBe("bench-press");
    expect(queuedSets()[0].set_type).toBe("working");
  });

  it("squat(warmup) -> bench -> squat -> bench still logs bench as working", async () => {
    exList();
    await seed([
      { ...rx("sqw", "back-squat", "Back Squat", 60, 1), set_type: "warmup" },
      { ...rx("sq", "back-squat", "Back Squat", 100, 2) },
      { ...rx("bench", "bench-press", "Bench Press", 60, 2), position: 2 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Back Squat" });
    await pause(120);
    const go = async (name: RegExp) => {
      today();
      fireEvent.click(await screen.findByRole("button", { name }));
      await pause(150);
    };
    await go(/^Bench Press/);
    await go(/^Back Squat/);
    await go(/^Bench Press/);
    fireEvent.click(document.querySelector(".focus-log") as HTMLElement);
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    expect(queuedSets()[0].exercise_id).toBe("bench-press");
    expect(queuedSets()[0].set_type).toBe("working");
  });
});

describe("N2 a just-logged set is never 'Needs review' while the exact read is slow", () => {
  it("LAST SET says On this phone immediately, with a hanging exact-id read", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    const data = await import("../lib/data");
    vi.mocked(data.getExactSetReceiptIds).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    let notify: (() => void) | null = null;
    vi.mocked(outbox.subscribe).mockImplementation((f: () => void) => {
      notify = f;
      return () => undefined;
    });
    const entries: unknown[] = [];
    vi.mocked(outbox.inspect).mockImplementation(async () => entries as never);
    vi.mocked(outbox.enqueue).mockImplementation(async (op) => {
      entries.push({
        key: entries.length + 1,
        op,
        table: op.table,
        created_at: null,
        retries: 0,
        last_error: null,
        user_id: "aaaaaaaa-1111-4111-8111-111111111111",
      });
      notify?.();
    });
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    await pause(400);
    const receipts = [...document.querySelectorAll(".set-receipt")].map((e) => e.textContent ?? "");
    expect(receipts.length).toBeGreaterThan(0);
    for (const text of receipts) {
      expect(text).not.toMatch(/review/i);
      expect(text).toMatch(/On this phone|Sending/);
    }
  });
});
