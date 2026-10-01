// @vitest-environment jsdom
// Base weight is a per-exercise preference (settings.ts), not the shared bar
// catalog. The sheet steps it with -/+ (one plate step), types it via the pad,
// and switches a machine between plate sled and pin stack.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlateSheet } from "./PlateSheet";
import {
  getExercisePref,
  resetAllSettings,
  setExerciseBarKg,
  setExerciseLoadStyle,
} from "../lib/settings";

afterEach(() => {
  cleanup();
  resetAllSettings();
});

function open(
  equipment: string | null,
  o: {
    onTypeBase?: () => void;
    exerciseId?: string;
    name?: string;
    unit?: "kg" | "lb";
    targetKg?: number;
  } = {},
) {
  return render(
    <PlateSheet
      exerciseId={o.exerciseId ?? "ex-1"}
      exerciseName={o.name ?? "Test Exercise"}
      targetKg={o.targetKg ?? 100}
      unit={o.unit ?? "kg"}
      equipment={equipment}
      onTypeTarget={() => {}}
      onTypeBase={o.onTypeBase ?? (() => {})}
      onClose={() => {}}
    />,
  );
}

describe("PlateSheet — barbell", () => {
  it("shows the bar base card, no preset chips, no machine switch", () => {
    open("barbell");
    expect(screen.getByText("BASE WEIGHT · BAR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /NO BAR|NO BASE/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^BAR \d/i })).toBeNull();
    expect(screen.queryByText("Which machine?")).toBeNull();
    expect(screen.getByText("kg total")).toBeTruthy();
  });

  it("steps the base by 2.5 kg and never below 0", () => {
    setExerciseBarKg("ex-1", 5);
    open("barbell");
    fireEvent.click(screen.getByRole("button", { name: "increase base weight" }));
    expect(getExercisePref("ex-1").barKg).toBe(7.5);
    for (let i = 0; i < 4; i++)
      fireEvent.click(screen.getByRole("button", { name: "decrease base weight" }));
    expect(getExercisePref("ex-1").barKg).toBe(0);
    expect(
      (screen.getByRole("button", { name: "decrease base weight" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("steps by 5 lb in pounds", () => {
    setExerciseBarKg("ex-1", 45 * 0.45359237);
    open("barbell", { unit: "lb" });
    fireEvent.click(screen.getByRole("button", { name: "increase base weight" }));
    expect(getExercisePref("ex-1").barKg).toBeCloseTo(50 * 0.45359237, 1);
  });
});

describe("PlateSheet — plate-loaded machine", () => {
  it("labels the base SLED and opens the pad on Type", () => {
    const onTypeBase = vi.fn();
    setExerciseBarKg("leg-press", 100);
    open("machine", { onTypeBase, exerciseId: "leg-press", name: "Leg Press" });
    expect(screen.getByText("BASE WEIGHT · SLED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(onTypeBase).toHaveBeenCalledTimes(1);
  });

  it("switches sled/stack, writing the pref", () => {
    open("machine", { exerciseId: "leg-press", name: "Leg Press" });
    const stack = screen.getByRole("button", { name: "Pin stack" });
    expect(screen.getByRole("button", { name: "Plate sled" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(stack);
    expect(getExercisePref("leg-press").loadStyle).toBe("stack");
    fireEvent.click(screen.getByRole("button", { name: "Plate sled" }));
    expect(getExercisePref("leg-press").loadStyle).toBe("plates");
  });

  it("stack mode shows the pin and hides base weight", () => {
    setExerciseLoadStyle("leg-press", "stack");
    open("machine", { exerciseId: "leg-press", name: "Leg Press", targetKg: 60 });
    expect(screen.getByText("Pin at 60 kg")).toBeTruthy();
    expect(screen.queryByText(/BASE WEIGHT/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Type" })).toBeNull();
  });

  it("warns when the target cannot be made exactly", () => {
    setExerciseBarKg("leg-press", 20);
    open("machine", { exerciseId: "leg-press", name: "Leg Press", targetKg: 21 });
    expect(screen.getByRole("alert").textContent).toMatch(/exactly/i);
  });
});

describe("PlateSheet — what is offered where", () => {
  it("does not offer the sled switch for a cable exercise (Face Pull)", () => {
    open("cable", { exerciseId: "face-pull", name: "Face Pull", targetKg: 30 });
    expect(screen.queryByText("Which machine?")).toBeNull();
    // a cable defaults to a pin stack: it says where the pin goes, nothing more
    expect(screen.getByText("Pin at 30 kg")).toBeTruthy();
  });

  it("offers it for a chest press machine, where a plate-loaded sibling exists", () => {
    open("machine", { exerciseId: "cp", name: "Chest Press Machine" });
    expect(screen.getByText("Which machine?")).toBeTruthy();
  });

  it("does not offer it for a pin-only machine such as Leg Extension", () => {
    open("machine", { exerciseId: "le", name: "Leg Extension" });
    expect(screen.queryByText("Which machine?")).toBeNull();
  });

  it("keeps an earlier choice reachable so it can be undone", () => {
    setExerciseLoadStyle("fp", "plates");
    open("cable", { exerciseId: "fp", name: "Face Pull" });
    expect(screen.getByText("Which machine?")).toBeTruthy();
  });
});

describe("PlateSheet — sled weight is asked for, not assumed zero", () => {
  it("shows Not set and a Set sled weight key until a base exists", () => {
    const onTypeBase = vi.fn();
    open("machine", { exerciseId: "leg-press", name: "Leg Press", onTypeBase });
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.getByText(/Sled weight not set/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set sled weight" }));
    expect(onTypeBase).toHaveBeenCalledTimes(1);
  });

  it("an explicit zero is a fact: an empty sled reads Sled only", () => {
    setExerciseBarKg("leg-press", 0);
    open("machine", { exerciseId: "leg-press", name: "Leg Press", targetKg: 0 });
    expect(screen.queryByText("Not set")).toBeNull();
  });

  it("a barbell is never unset: its bar comes from the shared inventory", () => {
    open("barbell");
    expect(screen.queryByText("Not set")).toBeNull();
  });
});
