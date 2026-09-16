// @vitest-environment jsdom
// Base weight is a device-local preference (settings.ts), not the shared
// bar catalog — a leg press's sled and a squat's bar must never collide,
// and a machine's sheet must never offer the barbell-only catalog chips.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlateSheet } from "./PlateSheet";
import { resetAllSettings, setExerciseBarKg } from "../lib/settings";

afterEach(() => {
  cleanup();
  resetAllSettings();
});

function open(
  equipment: string | null,
  overrides: { onTypeBase?: () => void; exerciseId?: string } = {},
) {
  return render(
    <PlateSheet
      exerciseId={overrides.exerciseId ?? "ex-1"}
      exerciseName="Test Exercise"
      targetKg={100}
      unit="kg"
      equipment={equipment}
      onTypeTarget={() => {}}
      onTypeBase={overrides.onTypeBase ?? (() => {})}
      onClose={() => {}}
    />,
  );
}

describe("PlateSheet — barbell", () => {
  it("offers the shared bar catalog, labelled BAR / NO BAR", () => {
    open("barbell");
    expect(screen.getByRole("button", { name: "NO BAR" })).toBeTruthy();
    // The default bar catalog carries several entries (20/15/10 kg), so
    // more than one "BAR ..." chip is expected here.
    expect(
      screen.getAllByRole("button", { name: /^BAR /i }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^BASE /i })).toBeNull();
  });
});

describe("PlateSheet — plate-loaded machine", () => {
  it("relabels to BASE / NO BASE and offers a typed entry, not the bar catalog", () => {
    open("machine");
    expect(screen.getByRole("button", { name: "NO BASE" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "NO BAR" })).toBeNull();
    expect(screen.getByRole("button", { name: /^BASE /i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^BAR /i })).toBeNull();
  });

  it("opens the base-weight pad on tap and never writes to the bar catalog", () => {
    const onTypeBase = vi.fn();
    open("machine", { onTypeBase, exerciseId: "leg-press" });
    fireEvent.click(screen.getByRole("button", { name: /^BASE /i }));
    expect(onTypeBase).toHaveBeenCalledTimes(1);
  });

  it("names the base weight in the note, not 'bar'", () => {
    setExerciseBarKg("leg-press", 20);
    render(
      <PlateSheet
        exerciseId="leg-press"
        exerciseName="Leg Press"
        targetKg={100}
        unit="kg"
        equipment="machine"
        onTypeTarget={() => {}}
        onTypeBase={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/base with your plates/i)).toBeTruthy();
    expect(screen.queryByText(/bar with your plates/i)).toBeNull();
  });
});
