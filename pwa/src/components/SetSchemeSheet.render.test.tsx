// @vitest-environment jsdom
// The sheet as a person actually meets it. groupSets is unit-tested next door;
// what matters here is that the CONTROL appears for the movements that need it
// and that what the sheet hands back is the total, not the number typed.
//
// The bug: the plan editor had no per-hand concept at all, so "20" for a pair
// of dumbbells was stored as a 20 kg TOTAL and the session screen — which does
// resolve dumbbells as per-side — prefilled 10 a hand. Half the weight, on
// every dumbbell exercise, in a real user's plan.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetSchemeSheet, type SetGroup } from "./SetSchemeSheet";

afterEach(cleanup);

function open(props: Partial<Parameters<typeof SetSchemeSheet>[0]> = {}) {
  const onSave = vi.fn();
  render(
    <SetSchemeSheet
      exerciseName="Dumbbell Bench Press"
      equipment="dumbbell"
      unit="kg"
      startKg={40}
      busy={false}
      onCancel={() => {}}
      onSave={onSave}
      {...props}
    />,
  );
  return onSave;
}

const save = (onSave: ReturnType<typeof vi.fn>): SetGroup[] => {
  fireEvent.click(screen.getByRole("button", { name: /^add\b/i }));
  return onSave.mock.calls[0]![0] as SetGroup[];
};

describe("per-hand weight in the plan editor", () => {
  it("offers the control for a pair of dumbbells, defaulted to per hand", () => {
    open();
    expect(screen.getByRole("button", { name: /per hand/i })).toBeTruthy();
    expect(screen.getByText(/PER HAND ×2/)).toBeTruthy();
  });

  it("does not offer it for a barbell, which is one system", () => {
    open({ exerciseName: "Barbell Squat", equipment: "barbell" });
    expect(screen.queryByText(/PER HAND/)).toBeNull();
    expect(screen.queryByText(/^TOTAL$/)).toBeNull();
  });

  it("does not offer it for single-arm work, where one bell IS the system", () => {
    open({ exerciseName: "One-Arm Dumbbell Row", equipment: "dumbbell" });
    expect(screen.queryByText(/PER HAND ×2/)).toBeNull();
  });

  it("hands back the TOTAL, having doubled what was typed", () => {
    // startKg 40 is a stored total, so the steppers open at 20 per hand.
    const onSave = open();
    const groups = save(onSave);
    expect(groups[0]!.load_kg).toBe(40);
    expect(groups[0]!.load_entry).toBe("per_side");
  });

  it("switching to TOTAL stops doubling, and says so", () => {
    const onSave = open();
    fireEvent.click(screen.getByRole("button", { name: /per hand/i }));
    expect(screen.getByText(/^TOTAL$/)).toBeTruthy();
    const groups = save(onSave);
    // The typed number is unchanged; only its meaning is.
    expect(groups[0]!.load_kg).toBe(20);
    expect(groups[0]!.load_entry).toBe("total");
  });

  it("a barbell scheme stores exactly what was typed", () => {
    const onSave = open({
      exerciseName: "Barbell Squat",
      equipment: "barbell",
      startKg: 100,
    });
    const groups = save(onSave);
    expect(groups[0]!.load_kg).toBe(100);
    expect(groups[0]!.load_entry).toBe("total");
  });
});
