// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { getPlannedWorkouts, getResolvedPrescriptions, getExercises, updatePlannedWorkout, updatePrescription, cacheGet, toast } = vi.hoisted(() => ({
  getPlannedWorkouts: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getExercises: vi.fn(),
  updatePlannedWorkout: vi.fn(),
  updatePrescription: vi.fn(),
  cacheGet: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "workout-1" }),
}));

vi.mock("../lib/data", () => ({
  getPlannedWorkouts: (...args: unknown[]) => getPlannedWorkouts(...args),
  getResolvedPrescriptions: (...args: unknown[]) => getResolvedPrescriptions(...args),
  getExercises: (...args: unknown[]) => getExercises(...args),
  updatePlannedWorkout: (...args: unknown[]) => updatePlannedWorkout(...args),
  updatePrescription: (...args: unknown[]) => updatePrescription(...args),
  addPrescriptionGroups: vi.fn(),
  reorderPrescriptions: vi.fn(),
  saveWorkoutAsTemplate: vi.fn(),
  deletePlannedWorkout: vi.fn(),
  deletePrescription: vi.fn(),
  PlanEditRefused: class PlanEditRefused extends Error {},
  duplicatePlannedWorkout: vi.fn(),
  setPrescriptionSection: vi.fn(),
  swapWorkoutOrder: vi.fn(),
  weekOrder: (a: { day_index: number }, b: { day_index: number }) => a.day_index - b.day_index,
}));

vi.mock("../lib/db", () => ({
  cacheKeys: { activeSession: "activeSession" },
  cacheGet: (...args: unknown[]) => cacheGet(...args),
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: (...args: unknown[]) => toast(...args) }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  getSetting: () => ({ kg: 20, lb: 45 }),
}));
vi.mock("../hooks/useDragList", () => ({
  useDragList: (keys: string[]) => ({ order: keys, handlers: () => ({}) }),
}));
vi.mock("../components/Stepper", () => ({ Stepper: () => null }));
vi.mock("../components/NumberPad", () => ({ NumberPad: () => null }));
vi.mock("../components/NewExerciseSheet", () => ({ NewExerciseSheet: () => null }));
vi.mock("../components/SetSchemeSheet", () => ({ SetSchemeSheet: () => null }));
vi.mock("../components/Note", () => ({ Note: () => null }));
vi.mock("../components/ExercisePicker", () => ({ ExercisePicker: () => null }));

import { Plan } from "./Plan";

const workout = {
  id: "workout-1",
  program_id: "program-1",
  day_index: 0,
  label: "Day 1",
  notes: null,
  scheduled_date: "2026-09-23",
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  getPlannedWorkouts.mockResolvedValue({
    data: {
      programs: [],
      workouts: [workout],
    },
  });
  getResolvedPrescriptions.mockResolvedValue({ data: [] });
  getExercises.mockResolvedValue({ data: [] });
  updatePlannedWorkout.mockResolvedValue(undefined);
  cacheGet.mockResolvedValue({
    id: "session-1",
    planned_workout_id: "workout-1",
    started_at: "2026-09-23T10:00:00Z",
    workout_label: "Day 1",
  });
});

afterEach(cleanup);

describe("Plan with an active session", () => {
  it("shows why edits are locked and disables workout fields", async () => {
    render(<Plan />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Finish the active session before changing this workout or its place in the plan.",
    );
    expect(
      (screen.getByRole("textbox", { name: "workout name" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(cacheGet).toHaveBeenCalledWith("activeSession");
  });

  it("leaves workout fields editable when no session targets the workout", async () => {
    cacheGet.mockResolvedValue({
      id: "session-elsewhere",
      planned_workout_id: "another-workout",
      started_at: "2026-09-23T10:00:00Z",
      workout_label: "Other day",
    });
    render(<Plan />);

    expect(
      (await screen.findByRole("textbox", {
        name: "workout name",
      }) as HTMLInputElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses an edit that would keep a noncontiguous superset", async () => {
    cacheGet.mockResolvedValue(undefined);
    const rows = [
      prescription("curl", "Biceps curl", 0, 1),
      prescription("plank", "Plank", 1, null),
      prescription("pushdown", "Triceps pushdown", 2, 1),
    ];
    getResolvedPrescriptions.mockResolvedValue({ data: rows });
    render(<Plan />);

    const curl = await screen.findByRole("button", { name: /Biceps curl/ });
    fireEvent.click(curl);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(await screen.findByRole("button", { name: /Biceps curl/ }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Superset A needs two distinct exercises. Superset B needs two distinct exercises.",
        "error",
      );
    });
    expect(updatePrescription).not.toHaveBeenCalled();
  });
});

function prescription(
  exercise_id: string,
  exercise_name: string,
  position: number,
  superset_group: number | null,
) {
  return {
    id: `${exercise_id}-rx`,
    planned_workout_id: "workout-1",
    exercise_id,
    exercise_name,
    position,
    sets: 3,
    reps_min: 8,
    reps_max: 8,
    rest_seconds: null,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group,
    section: null,
    tracking: "reps",
    set_type: "working",
    load_entry: null,
  };
}
