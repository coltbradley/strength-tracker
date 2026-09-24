// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkoutPreviewSheet } from "./WorkoutPreviewSheet";
import type { PlannedWorkoutRow, ResolvedPrescriptionRow } from "../lib/types";

afterEach(cleanup);

const workout: PlannedWorkoutRow = {
  id: "w1",
  program_id: "p1",
  day_index: 0,
  label: "Upper strength",
  notes: "Keep two reps in reserve.",
  scheduled_date: "2026-09-26",
  plan_note: "Short on time today.",
  skipped_at: null,
  exercise_count: 4,
};

const rx = (
  id: string,
  exerciseId: string,
  name: string,
  section: string | null,
  options: Partial<ResolvedPrescriptionRow> = {},
): ResolvedPrescriptionRow => ({
  id,
  planned_workout_id: workout.id,
  exercise_id: exerciseId,
  exercise_name: name,
  position: 0,
  sets: 3,
  reps_min: 5,
  reps_max: 8,
  rest_seconds: 90,
  notes: null,
  load_kg: 60,
  load_pct_tm: null,
  tm_kg: null,
  resolved_load_kg: 60,
  plate_load_kg: null,
  superset_group: null,
  section,
  ...options,
});

const prescriptions = [
  rx("bench-warmup", "bench", "Bench press", "Activation", {
    sets: 1,
    reps_min: 10,
    reps_max: 10,
    set_type: "warmup",
  }),
  rx("bench-work", "bench", "Bench press", "Activation", {
    sets: 3,
    reps_min: 5,
    reps_max: 5,
    notes: "Pause at the chest.",
  }),
  rx("row", "row", "Chest-supported row", null, { superset_group: 1 }),
  rx("curl", "curl", "Cable curl", null, { superset_group: 1 }),
  rx("fly", "fly", "Cable fly", null, { superset_group: 2 }),
];

function renderSheet(
  props: Partial<React.ComponentProps<typeof WorkoutPreviewSheet>> = {},
) {
  const onClose = vi.fn();
  const onStart = vi.fn();
  const view = render(
    <WorkoutPreviewSheet
      workout={workout}
      programName="September strength"
      prescriptions={prescriptions}
      loadState="loaded"
      unit="lb"
      startEnabled
      onClose={onClose}
      onStart={onStart}
      {...props}
    />,
  );
  return { onClose, onStart, ...view };
}

describe("WorkoutPreviewSheet", () => {
  it("shows sections, ramps, valid superset tags, targets, rest, and notes", () => {
    renderSheet();

    const dialog = screen.getByRole("dialog", { name: "Upper strength preview" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("First up")).toBeTruthy();
    expect(screen.getAllByText("Bench press")).toHaveLength(2);
    expect(screen.getByText("Activation")).toBeTruthy();
    expect(screen.getByText("Main work")).toBeTruthy();
    expect(screen.getByText("1×10 @ 132.3 lb warmup · 3×5 @ 132.3 lb")).toBeTruthy();
    expect(screen.getByText("Pause at the chest.")).toBeTruthy();
    expect(screen.getAllByText("A")).toHaveLength(2);
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.getAllByText("Rest 90 sec")).toHaveLength(4);
    expect(screen.getByText("Short on time today.")).toBeTruthy();
    expect(screen.getByText("Keep two reps in reserve.")).toBeTruthy();
    expect(screen.getByText("SAT 26 SEPT")).toBeTruthy();
  });

  it("does not tag a superset when its members are separated", () => {
    renderSheet({
      prescriptions: [
        rx("row", "row", "Chest-supported row", null, { superset_group: 1 }),
        rx("fly", "fly", "Cable fly", null),
        rx("curl", "curl", "Cable curl", null, { superset_group: 1 }),
      ],
    });

    expect(screen.queryByText("A")).toBeNull();
  });

  it("labels initial main work when a later section gives the workout structure", () => {
    renderSheet({
      prescriptions: [
        rx("squat", "squat", "Squat", null),
        rx("raise", "raise", "Lateral raise", "Accessories"),
      ],
    });

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Main work",
      "Accessories",
    ]);
  });

  it("keeps Start disabled when details have not loaded or could not be read", () => {
    const { rerender } = renderSheet({ prescriptions: null, loadState: "loading" });
    expect(screen.getByRole("button", { name: "Start workout" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/details are loading/i);

    rerender(
      <WorkoutPreviewSheet
        workout={workout}
        programName="September strength"
        prescriptions={null}
        loadState="error"
        unit="lb"
        startEnabled
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/couldn’t load workout details/i);
    expect(screen.getByRole("button", { name: "Start workout" }).hasAttribute("disabled")).toBe(true);
  });

  it("announces cached offline details and starts only the selected workout", () => {
    const { onStart } = renderSheet({ loadState: "cached-offline" });

    expect(screen.getByRole("status").textContent).toMatch(/offline, showing saved/i);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    expect(onStart).toHaveBeenCalledWith(workout);
  });
});
