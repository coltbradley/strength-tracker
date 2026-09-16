// @vitest-environment jsdom
// Decorative only: every icon must announce nothing itself (no aria-label,
// no title) — the caller wraps it in its own labelled control — and every
// one must render the shared 24x24, currentColor house style.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  BarbellIcon,
  DumbbellIcon,
  KettlebellIcon,
  PlateMachineIcon,
  StackIcon,
} from "./LoadIcons";

describe("LoadIcons", () => {
  it.each([
    ["BarbellIcon", BarbellIcon],
    ["PlateMachineIcon", PlateMachineIcon],
    ["StackIcon", StackIcon],
    ["DumbbellIcon", DumbbellIcon],
    ["KettlebellIcon", KettlebellIcon],
  ] as const)("%s renders a decorative 24x24 svg", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("g")?.getAttribute("stroke")).toBe(
      "currentColor",
    );
  });

  it("shows one dumbbell by default and two when count is 2", () => {
    const { container: one } = render(<DumbbellIcon />);
    const { container: two } = render(<DumbbellIcon count={2} />);
    expect(two.querySelectorAll("rect").length).toBeGreaterThan(
      one.querySelectorAll("rect").length,
    );
  });

  it("shows one kettlebell by default and two when count is 2", () => {
    const { container: one } = render(<KettlebellIcon />);
    const { container: two } = render(<KettlebellIcon count={2} />);
    expect(two.querySelectorAll("circle").length).toBeGreaterThan(
      one.querySelectorAll("circle").length,
    );
  });

  it("scales with the size prop", () => {
    const { container } = render(<BarbellIcon size={32} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("32");
    expect(svg?.getAttribute("height")).toBe("32");
  });
});
