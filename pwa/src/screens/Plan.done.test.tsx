// @vitest-environment jsdom
//
// Leaving the plan editor, and what it says about the day (UI-01, UI-03,
// UI-09). The mocks mirror Plan.active-session.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const {
  navigate,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  getExercises,
  applyPlanEdit,
  isPlannedDayLocked,
  cacheGet,
  toast,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  getPlannedWorkouts: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getExercises: vi.fn(),
  applyPlanEdit: vi.fn(),
  isPlannedDayLocked: vi.fn(),
  cacheGet: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: "workout-1" }),
}));
vi.mock("../lib/data", () => ({
  applyPlanEdit: (...a: unknown[]) => applyPlanEdit(...a),
  getPlannedWorkouts: (...a: unknown[]) => getPlannedWorkouts(...a),
  getResolvedPrescriptions: (...a: unknown[]) => getResolvedPrescriptions(...a),
  getExercises: (...a: unknown[]) => getExercises(...a),
  isPlannedDayLocked: (...a: unknown[]) => isPlannedDayLocked(...a),
  updatePlannedWorkout: vi.fn(),
  addPrescriptionGroups: vi.fn(),
  addSupersetGroups: vi.fn(),
  reorderPrescriptions: vi.fn(),
  saveWorkoutAsTemplate: vi.fn(),
  deletePlannedWorkout: vi.fn(),
  deletePrescription: vi.fn(),
  PlanEditRefused: class PlanEditRefused extends Error {},
  duplicatePlannedWorkout: vi.fn(),
  swapWorkoutOrder: vi.fn(),
  weekOrder: (a: { day_index: number }, b: { day_index: number }) =>
    a.day_index - b.day_index,
}));
vi.mock("../lib/db", () => ({
  cacheKeys: { activeSession: "activeSession" },
  cacheGet: (...a: unknown[]) => cacheGet(...a),
}));
vi.mock("../lib/errors", () => ({
  reportError: vi.fn(),
  toast: (...a: unknown[]) => toast(...a),
}));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "lb" }));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  getSetting: () => ({ kg: 20, lb: 45 }),
}));
vi.mock("../hooks/useDragList", () => ({
  useDragList: (keys: string[]) => ({ order: keys, handlers: () => ({}) }),
}));
vi.mock("../components/Stepper", () => ({
  Stepper: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (n: number) => void;
  }) => (
    <button
      type="button"
      aria-label={`${label} plus`}
      onClick={() => onChange(value + 1)}
    />
  ),
}));
vi.mock("../components/NumberPad", () => ({ NumberPad: () => null }));
vi.mock("../components/NewExerciseSheet", () => ({
  NewExerciseSheet: () => null,
}));
vi.mock("../components/SetSchemeSheet", () => ({ SetSchemeSheet: () => null }));
vi.mock("../components/Note", () => ({ Note: () => null }));
vi.mock("../components/ExercisePicker", () => ({ ExercisePicker: () => null }));

import { Plan, exercisesIn } from "./Plan";

const workout = {
  id: "workout-1",
  program_id: "program-1",
  day_index: 0,
  label: "Day 1",
  notes: null,
  scheduled_date: "2099-09-23",
  plan_note: null,
  skipped_at: null,
  exercise_count: 1,
};

function rx(
  exercise_id: string,
  name: string,
  position: number,
  over: Record<string, unknown> = {},
) {
  return {
    id: `${exercise_id}-${position}`,
    planned_workout_id: "workout-1",
    exercise_id,
    exercise_name: name,
    position,
    sets: 4,
    reps_min: 8,
    reps_max: 8,
    rest_seconds: null,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group: null,
    section: null,
    tracking: "reps",
    set_type: "working",
    load_entry: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPlannedWorkouts.mockResolvedValue({
    data: { programs: [], workouts: [workout] },
  });
  getResolvedPrescriptions.mockResolvedValue({
    data: [rx("curl", "Biceps curl", 0)],
  });
  getExercises.mockResolvedValue({ data: [] });
  applyPlanEdit.mockResolvedValue(undefined);
  isPlannedDayLocked.mockResolvedValue(false);
  cacheGet.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("UI-01: Done planning does not drop an open draft", () => {
  it("saves the open row, then leaves", async () => {
    render(<Plan />);
    fireEvent.click(await screen.findByRole("button", { name: /Biceps curl/ }));
    fireEvent.click(screen.getByRole("button", { name: "sets plus" }));
    fireEvent.click(screen.getByRole("button", { name: "Done planning" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
    expect(applyPlanEdit).toHaveBeenCalledTimes(1);
    expect(applyPlanEdit.mock.calls[0]![2]).toMatchObject({
      targetId: "curl-0",
      patch: expect.objectContaining({ sets: 5 }),
    });
  });

  it("stays, with the draft still open, when the save fails", async () => {
    applyPlanEdit.mockRejectedValue(new Error("network"));
    render(<Plan />);
    fireEvent.click(await screen.findByRole("button", { name: /Biceps curl/ }));
    fireEvent.click(screen.getByRole("button", { name: "sets plus" }));
    fireEvent.click(screen.getByRole("button", { name: "Done planning" }));

    await waitFor(() => expect(applyPlanEdit).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
    // the row is still in edit mode
    expect(
      screen.getByRole("button", { name: "Save planned sets" }),
    ).toBeTruthy();
  });

  it("leaves straight away when nothing is open", async () => {
    render(<Plan />);
    await screen.findByRole("button", { name: /Biceps curl/ });
    fireEvent.click(screen.getByRole("button", { name: "Done planning" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
    expect(applyPlanEdit).not.toHaveBeenCalled();
  });
});

describe("UI-03: a locked day says so before anyone types", () => {
  it("explains the lock and the way out", async () => {
    isPlannedDayLocked.mockResolvedValue(true);
    render(<Plan />);
    expect(
      await screen.findByText(/locked to keep that history accurate/),
    ).toBeTruthy();
    expect(
      screen.getByText(/duplicate this workout to a future date/),
    ).toBeTruthy();
  });

  it("says nothing on an ordinary day, or when the lock is unknown", async () => {
    isPlannedDayLocked.mockResolvedValue(null);
    render(<Plan />);
    await screen.findByRole("button", { name: /Biceps curl/ });
    expect(
      screen.queryByText(/locked to keep that history accurate/),
    ).toBeNull();
  });
});

describe("UI-09: one counting unit", () => {
  it("counts exercises, not rows: a ramp is one, a superset is each of its members", () => {
    expect(
      exercisesIn([{ exercises: 1 }, { exercises: 2 }, { exercises: 1 }]),
    ).toBe(4);
  });

  it("shows ramp rows as one exercise in the header", async () => {
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        rx("squat", "Squat", 0),
        rx("squat", "Squat", 1),
        rx("row", "Row", 2),
      ],
    });
    render(<Plan />);
    await screen.findAllByRole("button", { name: /Squat/ });
    const head = screen.getByText("EXERCISES").parentElement!;
    expect(head.textContent).toContain("2");
    expect(head.textContent).not.toContain("3");
  });
});

describe("UI-17: a timed row is labelled as timed", () => {
  it("says TIMED and does not print 'x 0' reps", async () => {
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        rx("carry", "Farmers Walk", 0, {
          tracking: "time",
          sets: 2,
          reps_min: 1,
          reps_max: 1,
        }),
      ],
    });
    render(<Plan />);
    const row = await screen.findByRole("button", { name: /Farmers Walk/ });
    expect(row.textContent).toContain("TIMED");
    expect(row.textContent).toContain("2 holds");
    fireEvent.click(row);
    expect(screen.getByText("TIMED HOLD")).toBeTruthy();
  });
});
