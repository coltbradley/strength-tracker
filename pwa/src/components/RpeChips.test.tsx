// @vitest-environment jsdom
// The rating is optional and off the set loop. The two things this component
// must never do are exist before anyone asked for it, and offer a value the
// column would refuse.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpeChips } from "./RpeChips";
import { RPE_CHOICES, RPE_MAX, RPE_SCALE } from "../lib/rpe";

afterEach(cleanup);

describe("RpeChips", () => {
  it("renders nothing at all until it is asked for", () => {
    const { container } = render(
      <RpeChips shown={false} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers 6.5 up to 10 in half points once shown", () => {
    render(<RpeChips shown value={null} onChange={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(RPE_CHOICES.length);
    expect(screen.getByRole("button", { name: "rpe 6.5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "rpe 10" })).toBeTruthy();
    // the chips are a subset of what the column accepts, never a superset
    expect(RPE_CHOICES.every((v) => RPE_SCALE.includes(v))).toBe(true);
    expect(RPE_CHOICES[RPE_CHOICES.length - 1]).toBe(RPE_MAX);
  });

  it("shows nothing selected when the set is unrated", () => {
    render(<RpeChips shown value={null} onChange={() => {}} />);
    for (const b of screen.getAllByRole("button"))
      expect(b.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the tapped value, and clears it when the same chip is tapped", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RpeChips shown value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "rpe 8.5" }));
    expect(onChange).toHaveBeenLastCalledWith(8.5);

    rerender(<RpeChips shown value={8.5} onChange={onChange} />);
    expect(
      screen
        .getByRole("button", { name: "rpe 8.5" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "rpe 8.5" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
