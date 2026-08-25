// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Stepper } from "./Stepper";

describe("Stepper", () => {
  it("bumps by the primary and fine steps, clamped at min", () => {
    const onChange = vi.fn();
    render(
      <Stepper
        label="load (kg)"
        value={100}
        display="100"
        step={2.5}
        fineStep={0.5}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText("increase load (kg)"));
    expect(onChange).toHaveBeenLastCalledWith(102.5);

    fireEvent.click(screen.getByLabelText("decrease load (kg)"));
    expect(onChange).toHaveBeenLastCalledWith(97.5);

    fireEvent.click(screen.getByLabelText("increase load (kg) (fine)"));
    expect(onChange).toHaveBeenLastCalledWith(100.5);

    fireEvent.click(screen.getByLabelText("decrease load (kg) (fine)"));
    expect(onChange).toHaveBeenLastCalledWith(99.5);
  });

  it("never goes below min", () => {
    const onChange = vi.fn();
    render(
      <Stepper
        label="reps"
        value={0}
        display="0"
        step={1}
        min={0}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("decrease reps"));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});
