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
