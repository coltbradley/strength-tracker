import { describe, expect, it } from "vitest";
import { buildScenario } from "./fixtures";

describe("demo fixtures", () => {
  it("models the enabled-by-default coach access relation instead of failing its read", () => {
    const { store } = buildScenario("default");

    expect(store.coach_access).toEqual([]);
  });

  it("includes narrow-phone coverage for paired load and completion-only focus", () => {
    const { store } = buildScenario("default");
    const today = store.planned_workouts.find(
      (workout) => workout.label === "Full Body · Squat Focus",
    );
    const todayRx = store.prescriptions.filter(
      (prescription) => prescription.planned_workout_id === today?.id,
    );

    expect(
      todayRx.find(
        (prescription) => prescription.exercise_id === "Seated_Dumbbell_Press",
      ),
    ).toMatchObject({ load_kg: 40, load_entry: "per_side" });
    expect(
      todayRx.find((prescription) => prescription.exercise_id === "Plank"),
    ).toMatchObject({ tracking: "done" });
  });
});
