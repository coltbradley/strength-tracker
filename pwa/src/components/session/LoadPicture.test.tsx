// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LoadPicture, PlateDiagram, StackDrawing, type LoadPictureModel } from "./LoadPicture";
import type { PlateSplit } from "../../lib/plates";
import { lbToKg } from "../../lib/units";

afterEach(cleanup);

const split: PlateSplit = {
  plates: [
    { plate: 25, count: 1 },
    { plate: 10, count: 1 },
    { plate: 2.5, count: 1 },
  ],
  perSideKg: 37.5,
  exact: true,
  achievedKg: 95,
};

function plates(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".lp-plate")].map((p) =>
    p.className.match(/lp-c-(\S+)/)![1],
  );
}

describe("PlateDiagram", () => {
  it("draws the left side smallest-outside and the right side heaviest-first", () => {
    const { container } = render(<PlateDiagram split={split} unit="kg" />);

    // [sleeve][left: 2.5 10 25][shaft][right: 25 10 2.5][sleeve]
    expect(plates(container)).toEqual(["2h", "10", "25", "25", "10", "2h"]);
    const shaft = container.querySelector(".lp-shaft")!;
    const all = [...container.querySelectorAll(".lp-bar > span")];
    const mid = all.indexOf(shaft);
    expect(all.slice(1, mid)).toHaveLength(3);
    expect(all.slice(mid + 1, -1)).toHaveLength(3);
  });

  it("compact draws one side only, smallest first with the collar on the right", () => {
    const { container } = render(<PlateDiagram split={split} unit="kg" compact />);
    expect(plates(container)).toEqual(["2h", "10", "25"]);
    expect(container.querySelector(".lp-bar-compact")).not.toBeNull();
  });

  it("draws just the bar for an empty split", () => {
    const { container } = render(
      <PlateDiagram split={{ ...split, plates: [], perSideKg: 0 }} unit="kg" />,
    );
    expect(plates(container)).toEqual([]);
    expect(container.querySelector(".lp-shaft")).not.toBeNull();
  });
});

describe("StackDrawing", () => {
  it("is a generic stack: equal plates, no pin position, no lifted plates", () => {
    const { container } = render(<StackDrawing />);
    const plates = container.querySelectorAll(".lp-stack-plate");
    expect(plates.length).toBeGreaterThan(3);
    expect(container.querySelector(".lp-stack-rod")).not.toBeNull();
    expect(container.querySelector(".is-lifted")).toBeNull();
    expect(container.textContent).toBe("");
    expect(container.innerHTML).not.toContain("◀");
  });
});

describe("LoadPicture", () => {
  it("plates: names the build and the bar, and a tap opens the plates sheet", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <LoadPicture
        unit="kg"
        model={{ kind: "plates", split, baseKg: 20, baseName: "Bar", onOpen }}
      />,
    );

    const button = screen.getByRole("button", {
      name: "25 + 10 + 2.5 per side. Bar 20 kg. Open plates",
    });
    expect(button.textContent).toContain("25 + 10 + 2.5 per side");
    expect(button.textContent).toContain("Bar 20 kg · change ›");
    expect(plates(container)).toHaveLength(6);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("plates: names the Sled for a plate-loaded machine and prefixes a superset tag", () => {
    render(
      <LoadPicture
        unit="lb"
        model={{
          kind: "plates",
          split: { ...split, plates: [{ plate: lbToKg(45), count: 2 }] },
          baseKg: lbToKg(100),
          baseName: "Sled",
          tag: "A1 · ",
          onOpen: vi.fn(),
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "A1 · 45 + 45 per side. Sled 100 lb. Open plates",
      }),
    ).toBeTruthy();
  });

  it("dumbbell pair: sums the two and a tap toggles to one", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <LoadPicture
        unit="lb"
        model={{ kind: "dumbbell", implementKg: lbToKg(50), pair: true, word: "dumbbell", onToggle }}
      />,
    );

    expect(container.querySelectorAll(".lp-db")).toHaveLength(2);
    const button = screen.getByRole("button", {
      name: "50 + 50 = 100 lb total. Switch to one dumbbell",
    });
    expect(button.textContent).toContain("Tap for one dumbbell");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("single kettlebell: one bell, offers two", () => {
    const { container } = render(
      <LoadPicture
        unit="kg"
        model={{ kind: "dumbbell", implementKg: 24, pair: false, word: "kettlebell", onToggle: vi.fn() }}
      />,
    );
    expect(container.querySelectorAll(".lp-db")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "24 kg · one kettlebell is the total. Switch to two kettlebells",
      }),
    ).toBeTruthy();
  });

  it("dumbbell without a toggle is a plain picture, not a button", () => {
    const { container } = render(
      <LoadPicture
        unit="kg"
        model={{ kind: "dumbbell", implementKg: 20, pair: true, word: "dumbbell" }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("20 + 20 = 40 kg total");
  });

  it("plates: asks for the sled weight instead of drawing plates around a guessed zero", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <LoadPicture
        unit="kg"
        model={{ kind: "plates", split, baseKg: 0, baseName: "Sled", baseKnown: false, onOpen }}
      />,
    );
    const button = screen.getByRole("button", { name: /Sled weight not set/ });
    expect(button.textContent).toContain("Sled weight not set");
    expect(button.textContent).toContain("Set sled weight ›");
    expect(plates(container)).toEqual([]);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("plates: an empty sled with a known base says Sled only", () => {
    render(
      <LoadPicture
        unit="kg"
        model={{
          kind: "plates",
          split: { ...split, plates: [], perSideKg: 0 },
          baseKg: 100,
          baseName: "Sled",
          onOpen: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText("Sled only")).toBeTruthy();
  });

  it("stack: shows the pin and is a button only when a switch exists", () => {
    const onOpen = vi.fn();
    const stack = (extra: Partial<Extract<LoadPictureModel, { kind: "stack" }>>): LoadPictureModel => ({
      kind: "stack",
      totalKg: 50,
      canSwitch: false,
      ...extra,
    });
    const { rerender } = render(<LoadPicture unit="kg" model={stack({})} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Pin at 50 kg")).toBeTruthy();
    expect(screen.getByText(/the number on the pin is the load/)).toBeTruthy();

    rerender(<LoadPicture unit="kg" model={stack({ canSwitch: true, onOpen, tag: "A2 · " })} />);
    expect(screen.getByText("A2 · Pin at 50 kg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/tap to switch to the plate sled/)).toBeTruthy();
  });

  it("bodyweight: offers + Add load until added load is on", () => {
    const onAddLoad = vi.fn();
    const { rerender } = render(
      <LoadPicture unit="kg" model={{ kind: "bodyweight", addedOn: false, onAddLoad }} />,
    );
    expect(screen.getByText("Bodyweight")).toBeTruthy();
    expect(screen.getByText(/Reps only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Add load (belt or vest)" }));
    expect(onAddLoad).toHaveBeenCalledTimes(1);

    rerender(
      <LoadPicture unit="kg" model={{ kind: "bodyweight", addedOn: true, onAddLoad }} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/added load is logged with each set/)).toBeTruthy();
  });

  it("bodyweight without a handler has no add-load button", () => {
    render(<LoadPicture unit="kg" model={{ kind: "bodyweight", addedOn: false }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
