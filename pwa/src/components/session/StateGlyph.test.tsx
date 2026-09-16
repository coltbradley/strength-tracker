// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { StateGlyph } from "./StateGlyph";

describe("StateGlyph", () => {
  it("renders a distinct, non-colour-only mark per state", () => {
    const marks = (
      ["done", "current", "next", "skipped", "upcoming"] as const
    ).map((state) => {
      const { container } = render(
        <StateGlyph state={state} label={`bench — ${state}`} />,
      );
      const el = container.querySelector(".state-glyph")!;
      return { state, className: el.className, text: el.textContent };
    });

    // Every state gets its own class AND its own glyph character — shape,
    // not colour, is what the DOM asserts here.
    expect(new Set(marks.map((m) => m.className)).size).toBe(5);
    expect(marks.find((m) => m.state === "done")!.text).toBe("✓");
    expect(marks.find((m) => m.state === "skipped")!.text).toBe("–");
    expect(marks.find((m) => m.state === "current")!.text).toBe("●");
    // "next" and "upcoming" share the hollow-dot GLYPH (the state table says
    // both are "hollow dot") but must still carry different classes, since
    // colour (full ink vs dim) is what tells them apart, and the class is
    // what carries that colour.
    expect(marks.find((m) => m.state === "next")!.text).toBe("○");
    expect(marks.find((m) => m.state === "upcoming")!.text).toBe("○");
    expect(marks.find((m) => m.state === "next")!.className).not.toBe(
      marks.find((m) => m.state === "upcoming")!.className,
    );
  });

  it("is decorative — assistive tech gets nothing from the glyph itself", () => {
    const { container } = render(
      <StateGlyph state="done" label="bench — done" />,
    );
    const el = container.querySelector(".state-glyph")!;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.getAttribute("role")).toBeNull();
    expect(el.getAttribute("title")).toBe("bench — done");
  });

  it("gets its own shape for a warmup set, independent of state", () => {
    const { container } = render(
      <StateGlyph state="current" warmup label="warmup 1 — current" />,
    );
    expect(container.querySelector(".state-glyph")!.className).toContain(
      "state-glyph-warmup",
    );
  });
});
