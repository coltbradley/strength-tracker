// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TrainHome, summarizeTrainWorkout } from "./TrainHome";
import type { PlannedWorkoutRow, ResolvedPrescriptionRow } from "../lib/types";

afterEach(cleanup);

const workout: PlannedWorkoutRow = {
  id: "push",
  program_id: "program",
  day_index: 0,
  label: "Upper strength",
  notes: null,
  scheduled_date: "2026-09-12",
  plan_note: null,
  skipped_at: null,
  exercise_count: 3,
};

const prescription = (
  id: string,
  exerciseId: string,
  name: string,
  sets: number,
): ResolvedPrescriptionRow => ({
  id,
  planned_workout_id: workout.id,
  exercise_id: exerciseId,
  exercise_name: name,
  position: 0,
  sets,
  reps_min: 5,
  reps_max: 8,
  rest_seconds: null,
  notes: null,
  load_kg: 60,
  load_pct_tm: null,
  tm_kg: null,
  resolved_load_kg: 60,
  plate_load_kg: null,
  superset_group: null,
});

const rows = [
  prescription("bench-ramp", "bench", "Bench press", 1),
  prescription("bench-work", "bench", "Bench press", 3),
  prescription("row", "row", "Chest-supported row", 4),
  prescription("curl", "curl", "Curl", 2),
];

function renderHome(
  props: Partial<React.ComponentProps<typeof TrainHome>> = {},
) {
  const onStart = vi.fn();
  const view = render(
    <MemoryRouter>
      <TrainHome
        dateContext="TODAY · SATURDAY 12 SEPTEMBER"
        programName="September strength"
        loading={false}
        loadIssue={null}
        workout={{ workout, state: "TODAY" }}
        prescriptions={rows}
        prescriptionLoadState="loaded"
        active={null}
        recovery={null}
        startEnabled
        onStart={onStart}
        onOpenCoach={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onStart, ...view };
}

describe("summarizeTrainWorkout", () => {
  it("counts a ramp as one movement and every prescribed set", () => {
    expect(summarizeTrainWorkout(rows)).toEqual({
      movementCount: 3,
      prescribedSetCount: 10,
      firstUp: "Bench press",
    });
  });
});

describe("TrainHome", () => {
  it("opens a read-only preview from Go without starting a session", () => {
    const { onStart } = renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByRole("dialog", { name: "Upper strength preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start workout" })).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows a planned workout's shape and starts it only from the preview", () => {
    const { onStart } = renderHome();

    expect(screen.getByText("Upper strength")).toBeTruthy();
    expect(screen.getByText("3 movements · 10 sets")).toBeTruthy();
    expect(screen.getByText("First up")).toBeTruthy();
    expect(screen.getByText("Bench press")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View program" }).getAttribute("href"),
    ).toBe("/program");
    expect(screen.queryByRole("button", { name: /check in/i })).toBeNull();
    expect(screen.queryByText(/weigh/i)).toBeNull();
    expect(screen.queryByText(/calendar/i)).toBeNull();
    expect(screen.queryByText(/5–8/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    expect(onStart).toHaveBeenCalledWith(workout);
  });

  it("makes Resume the only active-session action without naming a guessed exercise", () => {
    renderHome({
      active: {
        id: "session-1",
        planned_workout_id: workout.id,
        started_at: "2026-09-12T12:00:00.000Z",
        workout_label: workout.label,
      },
    });

    expect(
      screen.getByRole("link", { name: "Resume" }).getAttribute("href"),
    ).toBe("/session");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByText("Bench press")).toBeNull();
  });

  it("treats a completed workout as a Record action", () => {
    renderHome({ workout: { workout, state: "DONE" } });

    expect(
      screen.getByRole("link", { name: "View record" }).getAttribute("href"),
    ).toBe("/history");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("names an empty drafted day as a draft, never a rest day", () => {
    renderHome({ workout: { workout, state: "DRAFT" }, prescriptions: [] });

    expect(screen.getByText("Upper strength")).toBeTruthy();
    expect(screen.getByText("No exercises planned yet.")).toBeTruthy();
    expect(screen.queryByText("Rest day")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View program" }).getAttribute("href"),
    ).toBe("/program");
  });

  it("keeps loading and load failures truthful without a dashboard", () => {
    const { rerender } = render(
      <MemoryRouter>
        <TrainHome
          dateContext="TODAY"
          programName={null}
          loading
          loadIssue={null}
          workout={null}
          prescriptions={null}
          prescriptionLoadState="loading"
          active={null}
          recovery={null}
          startEnabled={false}
          onStart={vi.fn()}
          onOpenCoach={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Loading your plan…")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <TrainHome
          dateContext="TODAY"
          programName={null}
          loading={false}
          loadIssue="offline"
          workout={null}
          prescriptions={null}
          prescriptionLoadState="loaded"
          active={null}
          recovery={null}
          startEnabled={false}
          onStart={vi.fn()}
          onOpenCoach={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText("Couldn’t load your plan while offline."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("does not mistake unavailable offline details for a pending load", () => {
    renderHome({ prescriptions: null, prescriptionLoadState: "offline" });

    expect(
      screen.getByText(
        "Workout details are unavailable offline. Refresh your plan to retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Workout details are loading.")).toBeNull();
  });

  it("announces cached workout details freshness", () => {
    renderHome({ prescriptionLoadState: "cached-error" });

    expect(screen.getByRole("status").textContent).toBe(
      "Couldn’t refresh, showing saved workout details.",
    );
  });

  it("routes rest days and first runs to Program or existing coach access", () => {
    const onOpenCoach = vi.fn();
    const { rerender } = renderHome({ workout: null });
    expect(screen.getByText("Rest day")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View program" })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <TrainHome
          dateContext="TODAY"
          programName={null}
          loading={false}
          loadIssue={null}
          workout={null}
          prescriptions={null}
          prescriptionLoadState="loaded"
          active={null}
          recovery={null}
          startEnabled={false}
          onStart={vi.fn()}
          onOpenCoach={onOpenCoach}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No program yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask the coach" }));
    expect(onOpenCoach).toHaveBeenCalledOnce();
  });
});

describe("check in link", () => {
  it("sits beside the date and opens the check-in", () => {
    const onCheckIn = vi.fn();
    renderHome({ onCheckIn });
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    expect(onCheckIn).toHaveBeenCalledTimes(1);
  });

  it("is absent when there is no one to check in", () => {
    renderHome();
    expect(screen.queryByRole("button", { name: /check in/i })).toBeNull();
  });
});
