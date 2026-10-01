import { describe, expect, it } from "vitest";
import { buildScenario, type DemoScenario } from "./fixtures";

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


describe("Version D demo fixtures", () => {
  it("primes a stable active Focus scenario with explicit prescription fields", () => {
    const { store, activeSessionCache } = buildScenario("versiond" as DemoScenario);

    expect(activeSessionCache?.session.id).toBe("sess-versiond");
    expect(activeSessionCache?.session.planned_workout_id).toBe("pw-versiond");
    expect(activeSessionCache?.prescriptions.length).toBeGreaterThan(5);
    expect(activeSessionCache?.prescriptions.every((row) =>
      Object.hasOwn(row, "tracking") && Object.hasOwn(row, "load_entry") &&
      Object.hasOwn(row, "set_type") && Object.hasOwn(row, "section"),
    )).toBe(true);
    expect(activeSessionCache?.prescriptions.some((row) => row.tracking === "time")).toBe(true);
    expect(activeSessionCache?.prescriptions.some((row) => row.tracking === "done")).toBe(true);
    expect(store.planned_workouts.some((row) => row.id === "pw-versiond")).toBe(true);
    expect(store.coach_observations).toEqual([]);
  });

  it("keeps a three-plus member named circuit in a separate stable scenario", () => {
    const { store, activeSessionCache } = buildScenario("versiond-circuit" as DemoScenario);

    expect(activeSessionCache?.session.id).toBe("sess-versiond-circuit");
    const members = activeSessionCache?.prescriptions.filter((row) => row.superset_group === 2) ?? [];
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(new Set(members.map((row) => row.exercise_id)).size).toBe(members.length);
    expect(members.every((row, index) =>
      index === 0 || row.position === members[index - 1]!.position + 1,
    )).toBe(true);
    expect(new Set(members.map((row) => row.superset_group))).toEqual(new Set([2]));
    expect(new Set(members.map((row) => row.section))).toEqual(new Set(["Circuit · three stations"]));
    expect(store.planned_workouts.some((row) => row.id === "pw-versiond-circuit")).toBe(true);
  });
});
