// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const route = vi.hoisted(() => ({ id: "workout-1" }));

const { getPlannedWorkouts, getResolvedPrescriptions, getExercises, updatePlannedWorkout, addPrescriptionGroups, addSupersetGroups, applyPlanEdit, cacheGet, toast } = vi.hoisted(() => ({
  getPlannedWorkouts: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getExercises: vi.fn(),
  updatePlannedWorkout: vi.fn(),
  addPrescriptionGroups: vi.fn(),
  addSupersetGroups: vi.fn(),
  applyPlanEdit: vi.fn(),
  cacheGet: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: route.id }),
}));

vi.mock("../lib/data", () => ({
  applyPlanEdit: (...args: unknown[]) => applyPlanEdit(...args),
  getPlannedWorkouts: (...args: unknown[]) => getPlannedWorkouts(...args),
  getResolvedPrescriptions: (...args: unknown[]) => getResolvedPrescriptions(...args),
  getExercises: (...args: unknown[]) => getExercises(...args),
  updatePlannedWorkout: (...args: unknown[]) => updatePlannedWorkout(...args),
  addPrescriptionGroups: (...args: unknown[]) => addPrescriptionGroups(...args),
  addSupersetGroups: (...args: unknown[]) => addSupersetGroups(...args),
  reorderPrescriptions: vi.fn(),
  saveWorkoutAsTemplate: vi.fn(),
  deletePlannedWorkout: vi.fn(),
  deletePrescription: vi.fn(),
  PlanEditRefused: class PlanEditRefused extends Error {},
  duplicatePlannedWorkout: vi.fn(),
  swapWorkoutOrder: vi.fn(),
  weekOrder: (a: { day_index: number }, b: { day_index: number }) => a.day_index - b.day_index,
}));

vi.mock("../lib/db", () => ({
  cacheKeys: { activeSession: "activeSession" },
  cacheGet: (...args: unknown[]) => cacheGet(...args),
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: (...args: unknown[]) => toast(...args) }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "lb" }));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  getSetting: () => ({ kg: 20, lb: 45 }),
}));
vi.mock("../hooks/useDragList", () => ({
  useDragList: (keys: string[]) => ({ order: keys, handlers: () => ({}) }),
}));
vi.mock("../components/Stepper", () => ({
  Stepper: ({ label, value, onChange }: {
    label: string;
    value: number;
    onChange: (next: number) => void;
  }) => (
    <button type="button" aria-label={`${label} plus`} onClick={() => onChange(value + 1)} />
  ),
}));
vi.mock("../components/NumberPad", () => ({ NumberPad: () => null }));
vi.mock("../components/NewExerciseSheet", () => ({ NewExerciseSheet: () => null }));
vi.mock("../components/SetSchemeSheet", () => ({
  SetSchemeSheet: ({ onSave }: { onSave: (groups: unknown[]) => void }) => (
    <button type="button" onClick={() => onSave([{
      sets: 3,
      reps_min: 8,
      reps_max: 8,
      load_kg: 20,
      set_type: "working",
      rest_seconds: 90,
      superset_group: 1,
      section: null,
      tracking: "reps",
      load_entry: "total",
      entered_load: 20,
      entered_unit: "kg",
    }])}>Save scheme</button>
  ),
}));
vi.mock("../components/Note", () => ({ Note: () => null }));
vi.mock("../components/ExercisePicker", () => ({
  ExercisePicker: ({ onPick }: { onPick: (exercise: { id: string; name: string; equipment: string }) => void }) => <>
    <button type="button" onClick={() => onPick({ id: "barbell-row", name: "Barbell Row", equipment: "barbell" })}>Pick Barbell Row</button>
    <button type="button" onClick={() => onPick({ id: "cable-row", name: "Cable Row", equipment: "cable" })}>Pick Cable Row</button>
  </>,
}));

import { Plan } from "./Plan";

// A-05: Plan starts a prescriptions read for the day in the URL and applied
// whatever came back, so a slow read for the PREVIOUS day could land after
// the new day's and fill the editor with the wrong workout's exercises, where
// an edit would then be written against the wrong rows.

const day = (id: string, label: string, day_index: number) => ({
  id,
  program_id: "program-1",
  day_index,
  label,
  notes: null,
  scheduled_date: null,
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  route.id = "workout-1";
  getPlannedWorkouts.mockResolvedValue({
    data: { programs: [], workouts: [day("workout-1", "Day 1", 0), day("workout-2", "Day 2", 1)] },
  });
  getExercises.mockResolvedValue({ data: [] });
  cacheGet.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("Plan navigation between days", () => {
  it("never shows the previous day's prescriptions after the route changes (A-05)", async () => {
    const slowDay1 = deferred<{ data: unknown[] }>();
    getResolvedPrescriptions.mockImplementation((id: string) =>
      id === "workout-1"
        ? slowDay1.promise
        : Promise.resolve({ data: [{ ...prescription("press", "Overhead press", 0, null), planned_workout_id: "workout-2" }] }),
    );

    const { rerender } = render(<Plan />);
    route.id = "workout-2";
    rerender(<Plan />);
    expect(await screen.findByRole("button", { name: /Overhead press/ })).toBeTruthy();

    // Day 1's read finally answers, after Day 2's.
    slowDay1.resolve({ data: [prescription("squat", "Back squat", 0, null)] });
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByRole("button", { name: /Back squat/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Overhead press/ })).toBeTruthy();
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
