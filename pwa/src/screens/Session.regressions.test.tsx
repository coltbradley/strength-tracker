// @vitest-environment jsdom
//
// One regression test per audit finding that is not a superset round (those
// live in Session.superset.test.tsx): C1, C2, M1, M2, M6, L2, L6, H2 and the
// spurious "Unlogged set changes" prompt. Each names its finding.

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

const played = vi.hoisted(() => vi.fn());
vi.mock("../lib/restCue", async (orig) => ({
  ...(await orig<typeof import("../lib/restCue")>()),
  playRestCue: played,
}));

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
  id: "session-regress-1",
  planned_workout_id: "workout-1",
  started_at: "2026-09-12T12:00:00.000Z",
  workout_label: "Push",
  plan_note: null,
  coach_note: null,
};

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

const fixSheet = () => within(screen.getByRole("dialog", { name: /^Fix / }));

describe("Corrections target the set's own exercise (C1) and the live row (C2)", () => {
  it("C1: Fix on the LAST SET card after the exercise advanced uses the set's own load convention", async () => {
    equipment(["bench-press", "Bench Press", "barbell"], ["dumbbell-row", "Dumbbell Row", "dumbbell"]);
    await seed([
      rx("bench", "bench-press", "Bench Press", 20, 1),
      { ...rx("row", "dumbbell-row", "Dumbbell Row", 20, 1), position: 1 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    // the deck has advanced to the per-side dumbbell row; the card still names the bench set
    await screen.findByRole("heading", { name: "Dumbbell Row" });
    expect(screen.getByText(/^Bench Press · set 1/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    const sheet = fixSheet();
    expect(within(screen.getByRole("dialog", { name: /^Fix / })).getByText(/Bench Press/)).toBeTruthy();
    fireEvent.click(sheet.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(sheet.getByRole("button", { name: "Save correction" }));

    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const replacement = vi.mocked(outbox.enqueueCorrection).mock.calls[0]![1];
    expect(replacement).toMatchObject({
      exercise_id: "bench-press",
      load_kg: 22.5,
      load_entry: "total",
      set_index: 0,
    });
  });

  it("C2: after a correction, LAST SET and Fix last name the replacement, and a second fix voids it once", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    const originalId = queuedSets()[0]!.id;

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const [, firstReplacement, firstOriginal] = vi.mocked(outbox.enqueueCorrection).mock.calls[0]!;
    expect(firstOriginal).toBe(originalId);
    // the card now describes the replacement, not the voided row
    await vi.waitFor(() => expect(screen.getByText("Bench Press · set 1 · 60 kg × 6")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(2));
    const [, secondReplacement, secondOriginal] = vi.mocked(outbox.enqueueCorrection).mock.calls[1]!;
    // the second correction starts from the live replacement: no second void of the first row
    expect(secondOriginal).toBe(firstReplacement.id);
    expect(secondOriginal).not.toBe(originalId);
    expect(secondReplacement).toMatchObject({ reps: 7, set_index: 0 });
  });

  it("C2/M2: the Note key rates the live row and never a voided one", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(fixSheet().getByRole("button", { name: "Save correction" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const replacementId = vi.mocked(outbox.enqueueCorrection).mock.calls[0]![1].id;
    await vi.waitFor(() => expect(screen.getByText("Bench Press · set 1 · 60 kg × 6")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    fireEvent.change(await screen.findByPlaceholderText("Anything worth remembering about this set…"), {
      target: { value: "paused" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await vi.waitFor(() =>
      expect(
        vi.mocked(outbox.enqueue).mock.calls.some(
          ([op]) => op.kind === "insert" && op.table === "set_notes" && (op.payload as { set_id: string }).set_id === replacementId,
        ),
      ).toBe(true),
    );
  });

  it("M2: with the only set voided the Note and Fix last keys have nothing to point at", async () => {
    const set: SetInsert = {
      id: "lonely-set", session_id: active.id, exercise_id: "bench-press",
      prescription_id: "bench", set_index: 0, set_type: "working", load_kg: 60,
      reps: 5, performed_at: "2026-09-12T12:05:00.000Z", rest_seconds_actual: null,
      load_entry: "total", rpe: null,
    };
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)], [set]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Void logged set 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm void logged set 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Focus" }));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Note" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByRole("button", { name: "Fix last" })).toBeNull();
    expect(screen.getByRole("button", { name: "Swap" })).toBeTruthy();
  });
});

describe("RPE and Note keys say which set they rate (M1)", () => {
  it("M1: during a rest the RPE sheet rates the set just saved, not the next one", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    const originalId = queuedSets()[0]!.id;

    fireEvent.click(screen.getByRole("button", { name: "RPE" }));
    const sheet = within(await screen.findByRole("dialog", { name: "Rate set 1, just saved" }));
    fireEvent.click(sheet.getByRole("button", { name: "rpe 8" }));
    await vi.waitFor(() => expect(vi.mocked(outbox.enqueueCorrection)).toHaveBeenCalledTimes(1));
    const [, replacement, original] = vi.mocked(outbox.enqueueCorrection).mock.calls[0]!;
    expect(original).toBe(originalId);
    expect(replacement).toMatchObject({ rpe: 8, set_index: 0 });

    // the staged next set was not rated: logging it carries no RPE
    fireEvent.click(within(screen.getByRole("dialog", { name: /Rate set 1/ })).getByRole("button", { name: "CLOSE" }));
    await pause();
    fireEvent.click(screen.getByRole("button", { name: /^LOG SET$/ }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(2));
    expect(queuedSets()[1]!.rpe ?? null).toBeNull();
  });

  it("M1: with no rest running the RPE sheet is for the next set", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "RPE" }));
    expect(await screen.findByRole("dialog", { name: "RPE for the next set" })).toBeTruthy();
  });
});

describe("Focus state does not leak between entries (M6)", () => {
  it("M6: an open skip prompt does not follow a jump to another exercise", async () => {
    await seed([
      rx("bench", "bench-press", "Bench Press", 60, 3),
      { ...rx("squat", "back-squat", "Back Squat", 100, 3), position: 1 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("group", { name: "Skip reason" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back Squat/ }));
    expect(await screen.findByRole("heading", { name: "Back Squat" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Skip reason" })).toBeNull();
  });
});

describe("Header and leave prompt", () => {
  it("L6: the header count excludes skipped exercises, so it can reach its total", async () => {
    await seed([
      rx("bench", "bench-press", "Bench Press", 60, 1),
      { ...rx("squat", "back-squat", "Back Squat", 100, 1), position: 1 },
    ]);
    await cacheSet(cacheKeys.sessionSkips(active.id), ["bench"]);
    renderSession();
    await screen.findByRole("heading", { name: "Back Squat" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    expect(await screen.findByRole("button", { name: "Today's workout, 1 of 1 sets done" })).toBeTruthy();
  });

  it("M6-UX: logging a set and leaving does not claim there are unlogged changes", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByText("LAST SET");
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back to Train/ }));
    expect(screen.queryByRole("dialog", { name: "Unlogged set changes" })).toBeNull();
  });

  it("an edited, unlogged set still asks before Home discards it", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back to Train/ }));
    expect(await screen.findByRole("dialog", { name: "Unlogged set changes" })).toBeTruthy();
  });
});

describe("Superset keys act on the round (L2)", () => {
  it("L2: Fix last names the newest set across both members, not always A1", async () => {
    await seed([
      { ...rx("bench", "bench-press", "Bench Press", 20, 2), superset_group: 1 },
      { ...rx("row", "barbell-row", "Barbell Row", 20, 2), superset_group: 1, position: 1 },
    ]);
    renderSession();
    await screen.findByText("round 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Log A1" }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(1));
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "Log A2" }));
    await vi.waitFor(() => expect(queuedSets()).toHaveLength(2));
    await pause();
    // the newest set is A2's
    fireEvent.click(await screen.findByRole("button", { name: "Fix" }));
    expect(within(screen.getByRole("dialog", { name: /^Fix / })).getByText(/Barbell Row/)).toBeTruthy();
  });
});

describe("The rest-over cue is announced once (H2)", () => {
  it("H2: sheets and the Focus/List switch do not replay an over rest's tone", async () => {
    await seed([rx("bench", "bench-press", "Bench Press", 60, 3)]);
    await cacheSet(cacheKeys.sessionRest(active.id), {
      startedAt: Date.now() - 61_000,
      targetSeconds: 60,
      forLabel: "Bench Press set 1",
    });
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await vi.waitFor(() => expect(played).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "RPE" }));
    fireEvent.click(await screen.findByRole("button", { name: "CLOSE" }));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    fireEvent.click(screen.getByRole("button", { name: /^Today's workout,/ }));
    fireEvent.click(await screen.findByRole("button", { name: "CLOSE" }));
    await pause(500);
    expect(played).toHaveBeenCalledTimes(1);
  });
});

describe("Skipping during a rest", () => {
  it("08-ux M9: a skipped exercise has no NEXT SET tag and no LOAD NEXT card", async () => {
    equipment(["bench-press", "Bench Press", "barbell"], ["back-squat", "Back Squat", "barbell"]);
    await seed([
      rx("bench", "bench-press", "Bench Press", 60, 1),
      { ...rx("squat", "back-squat", "Back Squat", 100, 3), position: 1 },
    ]);
    renderSession();
    await screen.findByRole("heading", { name: "Bench Press" });
    await pause(80);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET" }));
    await screen.findByRole("heading", { name: "Back Squat" });
    expect(screen.getByText(/^NEXT SET/)).toBeTruthy();
    expect(screen.getByText("LOAD NEXT")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Out of time" }));
    expect(await screen.findByText("Skipped · Out of time. Unskip to log it.")).toBeTruthy();
    expect(screen.queryByText(/^NEXT SET/)).toBeNull();
    expect(screen.queryByText("LOAD NEXT")).toBeNull();
  });
});
