// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { getPlannedWorkouts, getResolvedPrescriptions, getExercises, updatePlannedWorkout, updatePrescription, addPrescriptionGroups, cacheGet, toast } = vi.hoisted(() => ({
  getPlannedWorkouts: vi.fn(),
  getResolvedPrescriptions: vi.fn(),
  getExercises: vi.fn(),
  updatePlannedWorkout: vi.fn(),
  updatePrescription: vi.fn(),
  addPrescriptionGroups: vi.fn(),
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
  addPrescriptionGroups: (...args: unknown[]) => addPrescriptionGroups(...args),
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
  ExercisePicker: ({ onPick }: { onPick: (exercise: { id: string; name: string; equipment: string }) => void }) => (
    <button type="button" onClick={() => onPick({ id: "cable-row", name: "Cable Row", equipment: "cable" })}>Pick Cable Row</button>
  ),
}));

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
  it("preserves the exact authored load when changing an unrelated field", async () => {
    cacheGet.mockResolvedValue(undefined);
    const row = {
      ...prescription("curl", "Biceps curl", 0, null),
      load_kg: 102.17,
      resolved_load_kg: 102.17,
      load_entry: "total",
      entered_load: 225.25,
      entered_unit: "lb",
    };
    getResolvedPrescriptions.mockResolvedValue({ data: [row] });
    render(<Plan />);

    fireEvent.click(await screen.findByRole("button", { name: /Biceps curl/ }));
    fireEvent.click(screen.getByRole("button", { name: "reps min plus" }));
    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));

    await waitFor(() => expect(updatePrescription).toHaveBeenCalled());
    expect(updatePrescription.mock.calls[0]![2]).toMatchObject({
      reps_min: 9,
      load_kg: 102.17,
      entered_load: 225.25,
      entered_unit: "lb",
    });
  });

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

  it("refuses adding to a separated superset before inserting any rows", async () => {
    cacheGet.mockResolvedValue(undefined);
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        prescription("bench", "Bench Press", 0, 1),
        prescription("row", "Barbell Row", 1, 1),
        prescription("plank", "Plank", 2, null),
      ],
    });
    render(<Plan />);

    fireEvent.click(await screen.findByRole("button", { name: "Add exercise" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick Cable Row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save scheme" }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Superset A must be contiguous in workout order.",
        "error",
      );
    });
    expect(addPrescriptionGroups).not.toHaveBeenCalled();
  });

  it("allows a valid third member without imposing a group-size cap", async () => {
    cacheGet.mockResolvedValue(undefined);
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        prescription("bench", "Bench Press", 0, 1),
        prescription("row", "Barbell Row", 1, 1),
      ],
    });
    addPrescriptionGroups.mockResolvedValue("cable-row-rx");
    render(<Plan />);

    fireEvent.click(await screen.findByRole("button", { name: "Add exercise" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick Cable Row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save scheme" }));

    await waitFor(() => expect(addPrescriptionGroups).toHaveBeenCalled());
    expect(addPrescriptionGroups).toHaveBeenCalledWith(
      "workout-1",
      "cable-row",
      [expect.objectContaining({ superset_group: 1 })],
      expect.arrayContaining([
        expect.objectContaining({ exercise_id: "bench", superset_group: 1 }),
        expect.objectContaining({ exercise_id: "row", superset_group: 1 }),
      ]),
    );
  });

  it("does not describe malformed legacy groups as alternated pairs", async () => {
    cacheGet.mockResolvedValue(undefined);
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        prescription("bench", "Bench Press", 0, 1),
        prescription("row", "Barbell Row", 1, 1),
        prescription("plank", "Plank", 2, null),
        prescription("curl", "Cable Curl", 3, 1),
      ],
    });
    render(<Plan />);

    const groupHeading = await screen.findByText("SUPERSET A");
    expect(groupHeading.parentElement?.textContent).toContain(
      "malformed group, fix its order before paired rounds",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Bench Press/ }));
    expect(screen.queryByText("Alternates with Barbell Row, Cable Curl.")).toBeNull();
    expect(screen.getByText(/Superset A must be fixed before paired rounds\./)).toBeTruthy();
  });

  it("labels a three-member group as an overview-only circuit", async () => {
    cacheGet.mockResolvedValue(undefined);
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        prescription("bench", "Bench Press", 0, 1),
        prescription("row", "Barbell Row", 1, 1),
        prescription("curl", "Cable Curl", 2, 1),
      ],
    });
    render(<Plan />);

    const groupHeading = await screen.findByText("SUPERSET A");
    expect(groupHeading.parentElement?.textContent).toContain(
      "3 exercises, overview-only circuit",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Bench Press/ }));
    expect(screen.getByText(/This group has 3 exercises and stays in the workout overview until circuit Focus is available\./)).toBeTruthy();
  });

  it("counts distinct exercises instead of ramp prescription rows", async () => {
    cacheGet.mockResolvedValue(undefined);
    getResolvedPrescriptions.mockResolvedValue({
      data: [
        prescription("bench-press", "Bench Press", 0, 1),
        {
          ...prescription("bench-press", "Bench Press", 1, 1),
          id: "bench-press-ramp",
        },
        prescription("barbell-row", "Barbell Row", 2, 1),
      ],
    });
    render(<Plan />);

    await screen.findByText("SUPERSET A");
    fireEvent.click(screen.getAllByRole("button", { name: /Bench Press/ })[0]!);
    expect(screen.getByText("Alternates with Barbell Row.")).toBeTruthy();
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
