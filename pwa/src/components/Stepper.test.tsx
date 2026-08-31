// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Stepper } from "./Stepper";

// RTL's automatic cleanup needs a global afterEach; vitest globals are off.
afterEach(cleanup);

describe("Stepper", () => {
  it("bumps by each step's delta, clamped to min/max", () => {
    const onChange = vi.fn();
    render(
      <Stepper
        label="load"
        display="100"
        value={100}
        min={0}
        max={999}
        onChange={onChange}
        steps={[
          { label: "− 5", delta: -5 },
          { label: "+ 5", delta: 5 },
          { label: "− 1", delta: -1, fine: true },
          { label: "+ 1", delta: 1, fine: true },
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("increase load by 5"));
    expect(onChange).toHaveBeenLastCalledWith(105);

    fireEvent.click(screen.getByLabelText("decrease load by 5"));
    expect(onChange).toHaveBeenLastCalledWith(95);

    fireEvent.click(screen.getByLabelText("increase load by 1"));
    expect(onChange).toHaveBeenLastCalledWith(101);

    fireEvent.click(screen.getByLabelText("decrease load by 1"));
    expect(onChange).toHaveBeenLastCalledWith(99);
  });

  it("never goes below min or above max", () => {
    const onChange = vi.fn();
    render(
      <Stepper
        label="reps"
        display="0"
        value={0}
        min={0}
        max={100}
        inline
        onChange={onChange}
        steps={[
          { label: "−", delta: -1 },
          { label: "+", delta: 200 },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText("decrease reps by 1"));
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByLabelText("increase reps by 200"));
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("renders the value as a span, not a disabled button, with no onTapValue", () => {
    const { container } = render(
      <Stepper
        label="sets"
        compact
        display="3 sets"
        value={3}
        onChange={() => undefined}
        steps={[{ label: "+", delta: 1 }]}
      />,
    );
    const value = container.querySelector(".stepper-value");
    expect(value?.tagName).toBe("SPAN");
    // compact implies the inline layout, and marks it as the editor field
    expect(container.querySelector(".stepper-inline.stepper-field")).not.toBe(
      null,
    );
  });

  it("tapping the value fires onTapValue (opens the pad)", () => {
    const onTap = vi.fn();
    render(
      <Stepper
        label="load"
        display="155"
        value={155}
        onChange={() => undefined}
        onTapValue={onTap}
        steps={[]}
      />,
    );
    fireEvent.click(screen.getByLabelText("load value — tap to type"));
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("snapping a load to the display grid", () => {
  // Loads are stored in kg and stepped by the DISPLAY unit's increment, so in
  // lb mode the step is five pounds expressed as 2.26796 kg. Without snapping,
  // a kg-authored 100 kg went 220.5 -> 225.5 -> 230.5 lb and never reached a
  // number anyone loads on a bar.
  const LB_STEP = 5 * 0.45359237;
  const kgToLb = (kg: number) => kg / 0.45359237;

  function bumped(startKg: number, delta: number, snap: boolean): number {
    const onChange = vi.fn();
    render(
      <Stepper
        label="load"
        display={`${startKg}`}
        value={startKg}
        min={0}
        max={999}
        snap={snap}
        onChange={onChange}
        steps={[{ label: "+", delta, announce: "5 lb" }]}
      />,
    );
    fireEvent.click(screen.getByLabelText(/increase load/i));
    return onChange.mock.calls[0]![0] as number;
  }

  it("lands on a round number in the display unit", () => {
    const next = bumped(100, LB_STEP, true);
    expect(Math.round(kgToLb(next))).toBe(225);
    expect(Math.abs(kgToLb(next) - 225)).toBeLessThan(0.01);
  });

  it("keeps stepping in round numbers, not 225.5 then 230.5", () => {
    let kg = 100;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      kg = bumped(kg, LB_STEP, true);
      seen.push(Math.round(kgToLb(kg) * 10) / 10);
      cleanup();
    }
    expect(seen).toEqual([225, 230, 235]);
  });

  it("is a no-op when the value is already on the grid", () => {
    // kg mode: 20 kg stepped by 2.5 is already round.
    expect(bumped(20, 2.5, true)).toBe(22.5);
  });

  it("without snap it adds the delta, for reps and seconds", () => {
    expect(bumped(8, 1, false)).toBe(9);
  });

  it("announces the step in the user's own unit, not the stored one", () => {
    render(
      <Stepper
        label="load"
        display="220.5 lb"
        value={100}
        min={0}
        max={999}
        onChange={() => undefined}
        steps={[{ label: "+", delta: LB_STEP, announce: "5 lb" }]}
      />,
    );
    expect(screen.getByLabelText("increase load by 5 lb")).toBeTruthy();
  });
});
